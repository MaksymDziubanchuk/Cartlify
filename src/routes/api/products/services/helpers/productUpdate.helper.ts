import { Prisma } from '@prisma/client';

import { buildProductUpdateAuditChanges, writeAdminAuditLog } from '@db/adminAudit.helper.js';
import {
  normalizeProductSafety,
  parseProductDescription,
  serializeProductDescription,
} from '@helpers/productDescription.js';
import { isSaleOn } from '@helpers/productSale.js';
import { readShippingChanges, resolveShippingData } from '@helpers/productShipping.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { BadRequestError, ConflictError, NotFoundError } from '@utils/errors.js';

import { computeFixedDelta, writeProductPriceChangeLog } from './priceChangeLog.helper.js';
import { assertCategoryExists } from './productCategory.helper.js';
import { productResponseSelect } from './productMapper.helper.js';
import { computeSalePrice, normalizeSaleEnd } from './productSale.helper.js';
import { putSaleOn, takeSaleOff, type SaleStepContext } from './productSaleSteps.helper.js';

// the context of a change of a product: batch says the change comes from the route of many
export type ProductWriteContext = SaleStepContext & { batch?: boolean };
import {
  assertPopularityOverridePair,
  normalizeSku,
  normalizeUpdateProductInput,
} from './products.helpers.js';

import type { UpdateProductBodyDto } from 'types/dto/products.dto.js';

// a change of a product, the same for one product (PATCH /api/products/:productId) and for many
// (PATCH /api/products/batch): the fields are read and checked first, then the product as it is
// under the lock of its row, then the steps are written in the transaction of the caller with
// every line of the logs. The images of a form are the business of the caller

// the fields of a change, each one left out or undefined when it is not sent
export type ProductUpdateFields = {
  [K in keyof UpdateProductBodyDto]?: UpdateProductBodyDto[K] | undefined;
};

export type ProductUpdatePlan = ReturnType<typeof planProductUpdate>;

// the fields sent, normalized; a change with nothing to change is refused, the images of a form
// are a change
export function planProductUpdate(fields: ProductUpdateFields, opts: { hasImages: boolean }) {
  const {
    name,
    description,
    sku,
    safety,
    price,
    stock,
    categoryId,
    popularityOverride,
    popularityOverrideUntil,
    sale,
  } = fields;

  // a stock sent is refused, it changes only with a delivery or a write-off
  const {
    nameNorm,
    descriptionNorm,
    priceRaw,
    categoryIdRaw,
    popularityOverrideRaw,
    popularityOverrideUntilDate,
  } = normalizeUpdateProductInput({
    name,
    description,
    price,
    stock,
    categoryId,
    popularityOverride,
    popularityOverrideUntil,
  });
  const skuNorm = normalizeSku(sku);
  // the safety data come whole and replace the ones of the product
  const safetyNorm = safety !== undefined ? normalizeProductSafety(safety) : undefined;
  // the weight and the sizes sent, each one a whole number or null
  const { changes: shippingChanges, without } = readShippingChanges(fields);

  // the word on the sale goes with a price; the sale alone has a route of its own
  if (sale !== undefined && price === undefined) {
    throw new BadRequestError('PRODUCT_SALE_REQUIRES_PRICE');
  }

  // reject empty patch
  const hasAnyUpdates =
    opts.hasImages ||
    name !== undefined ||
    description !== undefined ||
    safety !== undefined ||
    sku !== undefined ||
    price !== undefined ||
    categoryId !== undefined ||
    popularityOverride !== undefined ||
    popularityOverrideUntil !== undefined ||
    Object.keys(shippingChanges).length > 0;

  if (!hasAnyUpdates) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  // a new sale starts right away, its end is in the future
  const newSaleEndsAt = sale && sale !== 'keep' ? normalizeSaleEnd(sale.endsAt) : undefined;

  return {
    // as sent: the admin log names the fields given
    input: fields,
    nameNorm,
    descriptionNorm,
    priceRaw,
    categoryIdRaw,
    popularityOverrideRaw,
    popularityOverrideUntilDate,
    skuNorm,
    safetyNorm,
    shippingChanges,
    // the admin says the data come later (not kept): clearing what is known is allowed then
    withoutShippingData: without,
    newSaleEndsAt,
  };
}

// the product as it is before the change, for the checks, the admin log and the log of prices
export const productBeforeUpdateSelect = {
  id: true,
  name: true,
  description: true,
  sku: true,
  price: true,
  salePrice: true,
  saleEndsAt: true,
  categoryId: true,
  weightGrams: true,
  lengthMm: true,
  widthMm: true,
  heightMm: true,
  popularityOverride: true,
  popularityOverrideUntil: true,
  popularity: true,
  deletedAt: true,
} as const;

export type ProductBeforeUpdate = Prisma.ProductGetPayload<{
  select: typeof productBeforeUpdateSelect;
}>;

// the checks of a change against the product as it is, before anything is written: a product
// that is not there is PRODUCT_NOT_FOUND
export async function checkProductUpdate(
  db: Prisma.TransactionClient,
  plan: ProductUpdatePlan,
  before: ProductBeforeUpdate | null,
): Promise<ProductBeforeUpdate> {
  if (!before) throw new NotFoundError('PRODUCT_NOT_FOUND');

  const { sale, categoryId, popularityOverride, popularityOverrideUntil } = plan.input;
  const newSale = sale && sale !== 'keep' ? sale : undefined;

  // a new sale goes on a product of the catalog only, the same as on the route of the sale
  if (newSale && before.deletedAt) throw new NotFoundError('PRODUCT_NOT_FOUND');
  if (categoryId !== undefined) await assertCategoryExists(db, plan.categoryIdRaw!);

  // an override with its end, or neither: a change of one keeps the other one of the
  // product. A change that leaves the override alone is not checked, old rows of dev may
  // have an override without an end
  if (popularityOverride !== undefined || popularityOverrideUntil !== undefined) {
    assertPopularityOverridePair({
      popularityOverride:
        popularityOverride === undefined
          ? before.popularityOverride
          : (plan.popularityOverrideRaw ?? null),
      popularityOverrideUntil:
        popularityOverrideUntil === undefined
          ? before.popularityOverrideUntil
          : (plan.popularityOverrideUntilDate ?? null),
    });
  }

  // the sizes stay all three or none, what is known is cleared only when the admin says so
  if (Object.keys(plan.shippingChanges).length > 0) {
    resolveShippingData(before, plan.shippingChanges, plan.withoutShippingData);
  }

  // a new price of a product with a sale that is on says what happens to the sale: keep it,
  // take it off, or a new one
  const saleOn = isSaleOn(before);
  const newPrice = plan.priceRaw !== undefined ? new Prisma.Decimal(plan.priceRaw) : undefined;
  if (saleOn && newPrice && !newPrice.equals(before.price)) {
    if (sale === undefined) {
      throw new ConflictError('PRODUCT_SALE_DECISION_REQUIRED', {
        salePrice: decimalToNumber(before.salePrice),
        saleEndsAt: before.saleEndsAt!.toISOString(),
      });
    }
    // a sale stays below the price: a price down to it cannot keep it
    if (sale === 'keep' && newPrice.lessThanOrEqualTo(before.salePrice!)) {
      throw new ConflictError('PRODUCT_SALE_NOT_BELOW_PRICE', {
        salePrice: decimalToNumber(before.salePrice),
        price: decimalToNumber(newPrice),
      });
    }
  }

  // a new sale is counted from the new price (a word on the sale comes with a price): one that
  // does not fit it is refused before anything is written
  if (newSale) computeSalePrice(newPrice!, newSale);

  return before;
}

// writes a change that checkProductUpdate let through, under the lock of the row: the old sale
// off, the fields and the price, the new sale from the new price, each with every line of the
// logs, in the name of the admin of the context
export async function writeProductUpdate(
  ctx: ProductWriteContext,
  plan: ProductUpdatePlan,
  before: ProductBeforeUpdate,
) {
  const { db, actorId, actorRole } = ctx;
  const { input } = plan;
  const { sale } = input;

  // a sale that goes or comes here goes with the price
  const saleCtx: SaleStepContext = { ...ctx, source: 'with_price' };
  if (isSaleOn(before) && sale !== undefined && sale !== 'keep') await takeSaleOff(saleCtx, before);

  // build update payload only for provided fields
  // the description keeps the text and the safety data: a change of one keeps the other
  const kept = parseProductDescription(before.description);
  const data: Prisma.ProductUpdateInput = {
    ...(input.name !== undefined ? { name: plan.nameNorm! } : {}),
    ...(input.description !== undefined || plan.safetyNorm !== undefined
      ? {
          description: serializeProductDescription({
            text: input.description !== undefined ? plan.descriptionNorm || null : kept.text,
            safety: plan.safetyNorm ?? kept.safety,
          }),
        }
      : {}),
    ...(plan.skuNorm !== undefined ? { sku: plan.skuNorm } : {}),
    ...(input.price !== undefined ? { price: new Prisma.Decimal(plan.priceRaw!) } : {}),
    ...(input.categoryId !== undefined ? { categoryId: plan.categoryIdRaw! } : {}),
    ...plan.shippingChanges,
  };

  // apply explicit nulls only when client asked to clear values
  if (input.popularityOverride === null) {
    data.popularityOverride = null;
  } else if (input.popularityOverride !== undefined) {
    data.popularityOverride = plan.popularityOverrideRaw as number;
  }

  if (input.popularityOverrideUntil === null) {
    data.popularityOverrideUntil = null;
  } else if (input.popularityOverrideUntil !== undefined) {
    data.popularityOverrideUntil = plan.popularityOverrideUntilDate as Date;
  }

  // touch when images-only update
  if (!Object.keys(data).length) {
    data.updatedAt = new Date();
  }

  // persist product update under row lock; a price down to the sale price or below ends the
  // sale in the database (db/05), which writes its end in the admin log (PRODUCT_SALE)
  const after = await db.product.update({
    where: { id: before.id },
    data,
    select: productResponseSelect,
  });

  // build diff list for admin audit log
  const auditChanges = buildProductUpdateAuditChanges(before, {
    after,
    input: {
      name: input.name,
      description: input.description,
      safety: input.safety,
      sku: input.sku,
      price: input.price,
      categoryId: input.categoryId,
      popularityOverride: input.popularityOverride,
      popularityOverrideUntil: input.popularityOverrideUntil,
      ...plan.shippingChanges,
    },
  });

  // write admin audit log when something actually changed
  if (auditChanges.length) {
    await writeAdminAuditLog(db, {
      actorId,
      actorRole,
      entityType: 'product',
      entityId: after.id,
      action: 'PRODUCT_UPDATE',
      event: ctx.batch ? 'product.update_batch' : 'product.update',
      changes: auditChanges,
    });
  }

  // write product price change log when price changed
  if (input.price !== undefined && before.price.toString() !== after.price.toString()) {
    await writeProductPriceChangeLog(db, {
      productId: after.id,
      beforePrice: before.price,
      afterPrice: after.price,
      mode: 'fixed',
      value: computeFixedDelta(before.price, after.price),
      event: ctx.batch ? 'price.set_batch' : 'price.set',
    });
  }

  // the new sale is counted from the new price, after the old one went and the price changed
  return sale && sale !== 'keep'
    ? putSaleOn(
        saleCtx,
        { id: after.id, price: after.price, salePrice: null, saleEndsAt: null },
        sale,
        plan.newSaleEndsAt!,
      )
    : after;
}

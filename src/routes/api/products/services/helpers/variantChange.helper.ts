import { Prisma } from '@prisma/client';

import type { AuditChange } from '@db/adminAudit.helper.js';
import { isSaleOn } from '@helpers/productSale.js';
import { resolveShippingData } from '@helpers/productShipping.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { AppError, ConflictError, NotFoundError, isAppError } from '@utils/errors.js';

import { computeFixedDelta, writeVariantPriceChangeLog } from './priceChangeLog.helper.js';
import { computeSalePrice } from './productSale.helper.js';
import { putSaleOn, takeSaleOff } from './productSaleSteps.helper.js';
import { logVariant } from './variantWrite.helper.js';
import { writeValues, type VariantValuesToWrite } from './variantValues.helper.js';

import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';
import type { VariantChangePlan } from './variantInput.helper.js';

type Tx = Prisma.TransactionClient;

// The change of a variant that one variant, many variants of a product and many variants of any
// products share: the weight and the sizes, the price, the sale that goes with the price. The
// fields are read and checked first (variantInput.helper), then each variant as it is under the lock
// of its row (checkVariantChange), only then the steps are written in the transaction of the
// caller with every line of the logs (writeVariantChange)

// the variant as it is before the change: the fields the checks and the lines of the logs read
export type VariantChangeRow = {
  id: number;
  productId: number;
  price: Prisma.Decimal;
  salePrice: Prisma.Decimal | null;
  saleEndsAt: Date | null;
  salePriorPrice: Prisma.Decimal | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  deletedAt: Date | null;
};

// A new sale goes on a variant for sale of a product that is in the catalog, the same as on the
// route of the sale: the product that is out is PRODUCT_NOT_FOUND, the variant that is out
// VARIANT_NOT_FOUND
export function assertForSale(
  variant: Pick<VariantChangeRow, 'deletedAt'>,
  product: { deletedAt: Date | null },
): void {
  if (product.deletedAt) throw new NotFoundError('PRODUCT_NOT_FOUND');
  if (variant.deletedAt) throw new NotFoundError('VARIANT_NOT_FOUND');
}

// the checks of a change against the variant as it is, before anything is written
export function checkVariantChange(
  before: VariantChangeRow,
  product: { deletedAt: Date | null },
  plan: VariantChangePlan,
): void {
  const { sale } = plan;

  if (sale?.word === 'new') assertForSale(before, product);

  // the sizes stay all three or none, what is known is cleared only when the admin says so
  if (Object.keys(plan.shippingChanges).length > 0) {
    resolveShippingData(before, plan.shippingChanges, plan.withoutShippingData);
  }

  // a new price of a variant with a sale that is on says what happens to the sale: keep it, take it
  // off, or a new one
  const newPrice = plan.price !== undefined ? new Prisma.Decimal(plan.price) : undefined;
  if (isSaleOn(before) && newPrice && !newPrice.equals(before.price)) {
    if (sale === undefined) {
      throw new ConflictError('PRODUCT_SALE_DECISION_REQUIRED', {
        salePrice: decimalToNumber(before.salePrice),
        saleEndsAt: before.saleEndsAt!.toISOString(),
      });
    }
    // a sale stays below the price: a price down to it cannot keep it
    if (sale.word === 'keep' && newPrice.lessThanOrEqualTo(before.salePrice!)) {
      throw new ConflictError('PRODUCT_SALE_NOT_BELOW_PRICE', {
        salePrice: decimalToNumber(before.salePrice),
        price: decimalToNumber(newPrice),
      });
    }
  }

  // a new sale is counted from the new price (a word on the sale comes with a price): one that
  // does not fit it is refused before anything is written
  if (sale?.word === 'new') computeSalePrice(newPrice!, sale.sale);
}

// the weight and the sizes that really change, as the fields to write and the lines of the admin log
function shippingWritesOf(
  before: VariantChangeRow,
  changes: VariantChangePlan['shippingChanges'],
): { data: Prisma.ProductVariantUpdateInput; changes: AuditChange[] } {
  const data: Prisma.ProductVariantUpdateInput = {};
  const lines: AuditChange[] = [];

  for (const [field, value] of Object.entries(changes) as [
    'weightGrams' | 'lengthMm' | 'widthMm' | 'heightMm',
    number | null,
  ][]) {
    if (value === before[field]) continue;

    data[field] = value;
    lines.push({ field, old: before[field], new: value });
  }

  return { data, changes: lines };
}

// the context of a change of a variant: batch says the change comes from a route of many
export type VariantWriteContext = {
  db: Tx;
  actorId: UserId;
  actorRole: Role;
  batch?: boolean;
};

// what the caller adds to the one write of the variant: its own fields and their lines, and a step
// that comes after the row is written and before the line of the admin log (the place, the pictures)
export type VariantWriteExtra = {
  data?: Prisma.ProductVariantUpdateInput;
  changes?: AuditChange[];
  more?: (changes: AuditChange[]) => Promise<void>;
  // the values of characteristics to write (checked by the caller), with what the variant holds
  // now; the lines of the ones that changed go into the line of the log of the variant
  values?: VariantValuesToWrite;
};

// writes a change that checkVariantChange let through, under the lock of the row: the old sale off,
// the fields and the price, the new sale from the new price, each with every line of the logs, in
// the name of the admin of the context
export async function writeVariantChange(
  ctx: VariantWriteContext,
  before: VariantChangeRow,
  plan: VariantChangePlan,
  extra: VariantWriteExtra = {},
): Promise<{ valueChanges: AuditChange[] }> {
  const { db, actorId, actorRole } = ctx;
  const saleCtx = { db, actorId, actorRole, source: 'with_price' as const };
  const word = plan.sale?.word;

  // a sale that goes or comes here goes with the price
  if (isSaleOn(before) && (word === 'remove' || word === 'new')) await takeSaleOff(saleCtx, before);

  const shipping = shippingWritesOf(before, plan.shippingChanges);
  const data: Prisma.ProductVariantUpdateInput = { ...extra.data, ...shipping.data };
  const changes: AuditChange[] = [...(extra.changes ?? []), ...shipping.changes];

  // a price down to the sale price or below ends a sale in the database (db/05), which writes its
  // end in the admin log (PRODUCT_SALE); the checks keep a sale that is on from getting there
  const newPrice = plan.price !== undefined ? new Prisma.Decimal(plan.price) : undefined;
  const priceChanged = newPrice !== undefined && !newPrice.equals(before.price);
  if (priceChanged) {
    data.price = newPrice;
    changes.push({ field: 'price', old: before.price.toString(), new: newPrice.toString() });
  }

  if (Object.keys(data).length) {
    await db.productVariant.update({ where: { id: before.id }, data });
  }
  if (extra.more) await extra.more(changes);

  const valueChanges = extra.values
    ? await writeValues(db, before.id, extra.values.held, extra.values.resolved)
    : [];
  changes.push(...valueChanges);

  if (changes.length) {
    await logVariant(
      db,
      { actorId, actorRole },
      {
        event: ctx.batch ? 'variant.update_batch' : 'variant.update',
        variantId: before.id,
        changes,
      },
    );
  }

  if (priceChanged) {
    await writeVariantPriceChangeLog(db, {
      variantId: before.id,
      beforePrice: before.price,
      afterPrice: newPrice,
      mode: 'fixed',
      value: computeFixedDelta(before.price, newPrice),
      event: ctx.batch ? 'price.set_batch' : 'price.set',
    });
  }

  // the new sale is counted from the new price, after the old one went and the price changed
  if (plan.sale?.word === 'new') {
    await putSaleOn(
      saleCtx,
      {
        id: before.id,
        productId: before.productId,
        price: newPrice!,
        salePrice: null,
        saleEndsAt: null,
      },
      plan.sale.sale,
      plan.sale.endsAt,
    );
  }

  return { valueChanges };
}

// ---- a refusal that names every variant refused ----

// A change of many variants is all or nothing. The refusal is VARIANTS_INVALID with the status of
// the first variant refused (400, 404 or 409); details.variants has every variant refused with its
// own errorCode and details, in the order of the request
export function refusalOfVariants(
  problems: ReadonlyArray<{ variantId: number; err: AppError }>,
): AppError {
  const first = problems[0]!;

  return new AppError({
    statusCode: first.err.statusCode,
    errorCode: 'VARIANTS_INVALID',
    message: first.err.message,
    details: {
      variants: problems.map(({ variantId, err }) => ({
        variantId,
        errorCode: err.errorCode,
        ...(err.details !== undefined ? { details: err.details } : {}),
      })),
    },
    cause: first.err,
  });
}

// a check of each item in its order, every item checked: the results in the order of the items, or
// the refusal that names every item refused. An error that is no refusal of the app goes through as
// it is
export async function checkEveryVariant<T, R>(
  items: readonly T[],
  variantIdOf: (item: T) => number,
  check: (item: T, index: number) => R | Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const refused: Array<{ variantId: number; err: AppError }> = [];

  for (const [index, item] of items.entries()) {
    try {
      results.push(await check(item, index));
    } catch (err) {
      if (!isAppError(err)) throw err;
      refused.push({ variantId: variantIdOf(item), err });
    }
  }

  if (refused.length) throw refusalOfVariants(refused);

  return results;
}

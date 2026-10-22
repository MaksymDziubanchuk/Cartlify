import { buildSaleAuditChanges, writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { isSaleOn } from '@helpers/productSale.js';
import { ConflictError } from '@utils/errors.js';

import { computeFixedDelta, writeProductPriceChangeLog } from './priceChangeLog.helper.js';
import { productResponseSelect } from './productMapper.helper.js';
import { computeSalePrice } from './productSale.helper.js';

import type { Prisma } from '@prisma/client';
import type { SaleAuditEvent } from '@db/adminAudit.helper.js';
import type { ProductSaleDiscountDto, ProductSaleDto } from 'types/dto/products.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the steps of a sale, the same wherever a sale is set or taken off: the sale route, a change of
// a product and a change of many prices. Each writes its row and every line of the logs inside
// the transaction of the caller, in the name of the admin of its context

export type SaleStepContext = {
  db: Prisma.TransactionClient;
  actorId: UserId;
  actorRole: Role;
};

// the sale of a product before the step, and the price it is counted from
export type ProductSaleState = {
  id: number;
  price: Prisma.Decimal;
  salePrice: Prisma.Decimal | null;
  saleEndsAt: Date | null;
};

const auditSale = (
  ctx: SaleStepContext,
  before: ProductSaleState,
  event: SaleAuditEvent,
  after: Pick<ProductSaleState, 'salePrice' | 'saleEndsAt'>,
  discount?: ProductSaleDiscountDto,
) =>
  writeAdminAuditLog(ctx.db, {
    actorId: ctx.actorId,
    actorRole: ctx.actorRole,
    entityType: 'product',
    entityId: before.id,
    action: 'PRODUCT_SALE',
    changes: buildSaleAuditChanges({
      event,
      price: before.price,
      before,
      after,
      ...(discount ? { discount } : {}),
    }),
  });

// takes the sale that is on off (the caller checks it is on): its fields go, the log of prices
// gets the way from the sale price back to the price by an amount, the admin log the removed sale
export async function takeSaleOff(ctx: SaleStepContext, product: ProductSaleState) {
  const after = await ctx.db.product.update({
    where: { id: product.id },
    data: { salePrice: null, saleEndsAt: null },
    select: productResponseSelect,
  });

  await writeProductPriceChangeLog(ctx.db, {
    productId: product.id as any,
    beforePrice: product.salePrice,
    afterPrice: product.price,
    mode: 'fixed',
    value: computeFixedDelta(product.salePrice, product.price),
  });
  await auditSale(ctx, product, 'removed', after);

  return after;
}

// puts a sale on, counted from the price of the product, until the end (checked by the caller to
// be ahead). The log of prices gets its start from the price, whatever sale was there: a percent
// as it was given, an amount as it came out in cents, both negative; the admin log a sale that
// starts, or a change of the one that is on. The sale that is on already, the same sale price and
// end, is done already: 409 and nothing is written
export async function putSaleOn(
  ctx: SaleStepContext,
  product: ProductSaleState,
  sale: ProductSaleDto,
  endsAt: Date,
) {
  const wasOn = isSaleOn(product);
  const { salePrice, discount } = computeSalePrice(product.price, sale);

  if (
    wasOn &&
    salePrice.equals(product.salePrice!) &&
    product.saleEndsAt!.getTime() === endsAt.getTime()
  ) {
    throw new ConflictError('PRODUCT_SALE_ALREADY_SET');
  }

  const after = await ctx.db.product.update({
    where: { id: product.id },
    data: { salePrice, saleEndsAt: endsAt },
    select: productResponseSelect,
  });

  const given: ProductSaleDiscountDto =
    'percent' in sale ? { percent: sale.percent } : { amount: sale.amount };
  await writeProductPriceChangeLog(ctx.db, {
    productId: product.id as any,
    beforePrice: product.price,
    afterPrice: salePrice,
    mode: 'percent' in given ? 'percent' : 'fixed',
    value: 'percent' in given ? -given.percent : -discount.toNumber(),
    endsAt,
  });
  await auditSale(ctx, product, wasOn ? 'change' : 'start', after, given);

  return after;
}

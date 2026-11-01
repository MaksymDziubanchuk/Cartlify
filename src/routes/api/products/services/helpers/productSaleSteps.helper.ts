import { Prisma } from '@prisma/client';

import { buildSaleAuditChanges, writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { variantNamesOf } from '@db/variantNames.helper.js';
import { isSaleOn } from '@helpers/productSale.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { BadRequestError } from '@utils/errors.js';

import { computeFixedDelta, writeVariantPriceChangeLog } from './priceChangeLog.helper.js';
import { SALE_PRIOR_PRICE_DAYS, computeSalePrice, lowestPriceOf } from './productSale.helper.js';

import type { SaleAuditEvent } from '@db/adminAudit.helper.js';
import type { AuditEvent, SaleSource, WrittenEvent } from '@config/journalEvents.js';
import type {
  ProductSaleDiscountDto,
  ProductSaleDto,
  SaleStatus,
  VariantSaleResultDto,
} from 'types/dto/products.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the steps of a sale, the same wherever a sale is set or taken off: the sale route, a change of
// a variant and a change of many prices. Each writes its row and every line of the logs inside
// the transaction of the caller, in the name of the admin of its context. The sale is the
// variant's: its price is the one the sale is counted from, its history of prices the one the
// lowest price of the 30 days is read from, and the lines of the admin log are about the variant

export type SaleStepContext = {
  db: Prisma.TransactionClient;
  actorId: UserId;
  actorRole: Role;
  // where the sale is set or taken off: its own route (the default), the route of many sales, or
  // together with a price; the lines of the admin log tell it
  source?: SaleSource;
};

// the event of the line of a sale in the admin log
const SALE_EVENTS: Record<SaleSource, { set: AuditEvent; remove: AuditEvent }> = {
  route: { set: 'product.sale_set', remove: 'product.sale_remove' },
  bulk: { set: 'product.sale_set_bulk', remove: 'product.sale_remove' },
  with_price: { set: 'product.sale_set_with_price', remove: 'product.sale_remove_with_price' },
};

// the sale of a variant before the step, and the price it is counted from
export type VariantSaleState = {
  id: number;
  productId: number;
  price: Prisma.Decimal;
  salePrice: Prisma.Decimal | null;
  saleEndsAt: Date | null;
  // the lowest price of the 30 days before the sale; a sale from before it was written has none
  salePriorPrice?: Prisma.Decimal | null;
};

// the row of a variant a sale step works on: the sale and the price, the name of the product (the
// answers name the variant) and whether the product is out of the catalog
export const saleRowSelect = {
  id: true,
  productId: true,
  position: true,
  price: true,
  salePrice: true,
  saleEndsAt: true,
  salePriorPrice: true,
  deletedAt: true,
  product: { select: { name: true, deletedAt: true } },
} as const;

export type SaleRow = Prisma.ProductVariantGetPayload<{ select: typeof saleRowSelect }>;

// what the steps give back of the row they wrote
const saleStepSelect = {
  id: true,
  productId: true,
  price: true,
  salePrice: true,
  saleEndsAt: true,
  salePriorPrice: true,
} as const;

const DAY_MS = 86_400_000;

// the lowest price of the 30 days before a sale that starts now: the prices of the log of prices of
// the variant, read in the transaction of the step, and the price it sells at right now. The time
// is the one of the app, the dates of the log are utc as prisma keeps them
async function lowestPriorPrice(ctx: SaleStepContext, variant: VariantSaleState) {
  const to = new Date(Date.now());
  const from = new Date(to.getTime() - SALE_PRIOR_PRICE_DAYS * DAY_MS);
  const lines = await ctx.db.productPriceChangeLog.findMany({
    where: { variantId: variant.id, createdAt: { lt: to } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { oldPrice: true, newPrice: true, endsAt: true, createdAt: true },
  });
  const current = isSaleOn(variant) ? new Prisma.Decimal(variant.salePrice!) : variant.price;

  return lowestPriceOf({ lines, current, from, to });
}

const auditSale = (
  ctx: SaleStepContext,
  before: VariantSaleState,
  event: SaleAuditEvent,
  after: Pick<VariantSaleState, 'salePrice' | 'saleEndsAt'>,
  discount?: ProductSaleDiscountDto,
) =>
  writeAdminAuditLog(ctx.db, {
    actorId: ctx.actorId,
    actorRole: ctx.actorRole,
    entityType: 'variant',
    entityId: before.id,
    action: 'PRODUCT_SALE',
    event: SALE_EVENTS[ctx.source ?? 'route'][
      event === 'removed' ? 'remove' : 'set'
    ] as WrittenEvent<AuditEvent>,
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
export async function takeSaleOff(ctx: SaleStepContext, variant: VariantSaleState) {
  const after = await ctx.db.productVariant.update({
    where: { id: variant.id },
    data: { salePrice: null, saleEndsAt: null, salePriorPrice: null },
    select: saleStepSelect,
  });

  await writeVariantPriceChangeLog(ctx.db, {
    variantId: variant.id,
    beforePrice: variant.salePrice,
    afterPrice: variant.price,
    mode: 'fixed',
    value: computeFixedDelta(variant.salePrice, variant.price),
    event: 'price.sale_end',
  });
  await auditSale(ctx, variant, 'removed', after);

  return after;
}

// the sale that is on already, the same sale price and end (a percent and an amount that come to
// the same price are the same sale)
export function isSameSale(variant: VariantSaleState, sale: ProductSaleDto, endsAt: Date): boolean {
  return (
    isSaleOn(variant) &&
    computeSalePrice(variant.price, sale).salePrice.equals(variant.salePrice!) &&
    variant.saleEndsAt!.getTime() === endsAt.getTime()
  );
}

// puts a sale on, counted from the price of the variant, until the end (checked by the caller to
// be ahead). The log of prices gets its start from the price, whatever sale was there: a percent
// as it was given, an amount as it came out in cents, both negative; the admin log a sale that
// starts, or a change of the one that is on. The caller has found the sale not to be the one that
// is on already (isSameSale)
export async function putSaleOn(
  ctx: SaleStepContext,
  variant: VariantSaleState,
  sale: ProductSaleDto,
  endsAt: Date,
) {
  const wasOn = isSaleOn(variant);
  const { salePrice, discount } = computeSalePrice(variant.price, sale);

  // one reduction after another: a sale that replaces the one that is on keeps its lowest price
  const salePriorPrice =
    wasOn && variant.salePriorPrice != null
      ? variant.salePriorPrice
      : await lowestPriorPrice(ctx, variant);

  const after = await ctx.db.productVariant.update({
    where: { id: variant.id },
    data: { salePrice, saleEndsAt: endsAt, salePriorPrice },
    select: saleStepSelect,
  });

  const given: ProductSaleDiscountDto =
    'percent' in sale ? { percent: sale.percent } : { amount: sale.amount };
  await writeVariantPriceChangeLog(ctx.db, {
    variantId: variant.id,
    beforePrice: variant.price,
    afterPrice: salePrice,
    mode: 'percent' in given ? 'percent' : 'fixed',
    value: 'percent' in given ? -given.percent : -discount.toNumber(),
    event: 'price.sale_start',
    endsAt,
  });
  await auditSale(ctx, variant, wasOn ? 'change' : 'start', after, given);

  return after;
}

// ---- the sale of many variants at once ----

// a sale to put on a variant, or null to take its sale off
export type PlannedSale = {
  variantId: number;
  sale: ProductSaleDto | null;
  endsAt: Date | null;
};

// the codes of a sale that does not fit the price of a variant, the first one found named for the
// whole request with every variant it holds for
const SALE_PRICE_CODES = ['PRODUCT_SALE_AMOUNT_TOO_HIGH', 'PRODUCT_SALE_TOO_SMALL'] as const;

// a sale that does not fit the price of its variant: an amount above the price, a discount that
// rounds to nothing. The first such code names the request (400), `details.variants` has every
// variant it holds for ({ variantId, price } for an amount above the price)
export function assertSalesFit(
  planned: ReadonlyArray<PlannedSale>,
  rows: ReadonlyMap<number, Pick<SaleRow, 'price'>>,
): void {
  const refused = new Map<string, Array<{ variantId: number; price?: number }>>();

  for (const item of planned) {
    if (!item.sale) continue;

    const { price } = rows.get(item.variantId)!;
    try {
      computeSalePrice(price, item.sale);
    } catch (err) {
      if (!(err instanceof BadRequestError)) throw err;

      const list = refused.get(err.errorCode) ?? [];
      list.push(
        err.errorCode === 'PRODUCT_SALE_AMOUNT_TOO_HIGH'
          ? { variantId: item.variantId, price: decimalToNumber(price) }
          : { variantId: item.variantId },
      );
      refused.set(err.errorCode, list);
    }
  }

  for (const code of SALE_PRICE_CODES) {
    const variants = refused.get(code);
    if (variants) throw new BadRequestError(code, { variants });
  }
}

// the variant after a sale route: the sale fields only while a sale lasts
function resultOf(
  names: ReadonlyMap<number, { name: string }>,
  row: SaleRow,
  after: Pick<VariantSaleState, 'price' | 'salePrice' | 'saleEndsAt' | 'salePriorPrice'>,
  status: SaleStatus,
): VariantSaleResultDto {
  const on = isSaleOn(after);

  return {
    id: row.id,
    productId: row.productId as VariantSaleResultDto['productId'],
    name: names.get(row.id)?.name ?? row.product.name,
    price: decimalToNumber(after.price),
    salePrice: on ? decimalToNumber(after.salePrice) : null,
    saleEndsAt: on ? after.saleEndsAt!.toISOString() : null,
    salePriorPrice:
      on && after.salePriorPrice != null ? decimalToNumber(after.salePriorPrice) : null,
    status,
  };
}

// puts the sales on the variants, or takes them off, by id (the order the rows are locked in); the
// rows are locked and read by the caller. Every sale fits its price, or none is put on. The same
// sale that is on is left as it is (unchanged), so is a variant with no sale to take off
export async function applySales(
  ctx: SaleStepContext,
  planned: ReadonlyArray<PlannedSale>,
  rows: ReadonlyMap<number, SaleRow>,
): Promise<Map<number, VariantSaleResultDto>> {
  assertSalesFit(planned, rows);

  const results = new Map<number, VariantSaleResultDto>();
  // the names of the variants, read once (a sale changes no name)
  const names = await variantNamesOf(ctx.db, [...rows.keys()]);

  for (const item of [...planned].sort((a, b) => a.variantId - b.variantId)) {
    const before = rows.get(item.variantId)!;

    if (!item.sale) {
      if (!isSaleOn(before)) {
        results.set(before.id, resultOf(names, before, before, 'unchanged'));
        continue;
      }

      const after = await takeSaleOff(ctx, before);
      results.set(before.id, resultOf(names, before, after, 'removed'));
      continue;
    }

    if (isSameSale(before, item.sale, item.endsAt!)) {
      results.set(before.id, resultOf(names, before, before, 'unchanged'));
      continue;
    }

    const after = await putSaleOn(ctx, before, item.sale, item.endsAt!);
    results.set(before.id, resultOf(names, before, after, 'set'));
  }

  return results;
}

// a request all of whose variants stayed as they were: there was nothing to do
export const nothingChanged = (results: Iterable<VariantSaleResultDto>): boolean =>
  [...results].every((result) => result.status === 'unchanged');

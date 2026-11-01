import { Prisma } from '@prisma/client';

import { getPgCode, getPgMessage, prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { freeUnits } from '@db/expiredStock.helper.js';
import { variantNamesOf } from '@db/variantNames.helper.js';
import { shopToday } from '@helpers/shopDay.js';
import { BadRequestError, ConflictError, NotFoundError, type AppError } from '@utils/errors.js';

import type {
  ReceiveStockDto,
  StockLineRefDto,
  StockVariantRefDto,
  StockVariantSummaryDto,
  WriteOffReason,
  WriteOffStockDto,
} from 'types/dto/products.dto.js';
import type { ProductId, UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// a delivery takes in a batch of each of its items at its cost of a unit, in the currency of the
// shop; a write-off takes free units of a variant, from the batch named or from the batches in
// the order of a sale (the one that ends first, then the oldest). The functions of the database
// do both and check it all again (cartlify.receive_variant_batch, write_off_variant_stock, db/05);
// the server says first what the admin asked that cannot be done

const textOrNull = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

// the fields of a delivery item once the request is checked, besides the variant it names
export type DeliveryFields = {
  quantity: number;
  // a decimal string to the cent, as the database takes it
  unitCost: string;
  // the last good day, yyyy-mm-dd
  expiresAt: string | null;
  supplierBatchNumber: string | null;
};

export type DeliveryItem = DeliveryFields & { variantId: number; productId: number };

// how an item of a request names its variant, as the admin wrote it
const refOf = (item: StockVariantRefDto) =>
  item.variantId !== undefined
    ? { variantId: item.variantId }
    : item.sku !== undefined
      ? { sku: item.sku }
      : { barcode: item.barcode! };

// the items of a request with the id of their variant (and of its product): an item that names its
// variant by the article number or by the barcode gets the id of the live variant of the catalog
// that has it, whatever the case of the letters of a number. A variant named by its id has to be
// there, and alive too unless the request may touch a variant taken out of sale (a write-off may:
// its units wait for it). What the catalog has none of is 404 VARIANT_NOT_FOUND with every id,
// number and barcode of that kind in details.variantIds, details.skus and details.barcodes, and
// nothing is taken in or written off
export async function withVariantIds<T extends object>(
  items: Array<T & StockVariantRefDto>,
  actor: { actorId: UserId; actorRole: Role },
  opts: { deleted: boolean },
): Promise<Array<Omit<T, keyof StockVariantRefDto> & { variantId: number; productId: number }>> {
  const unique = <V>(values: V[]) => [...new Set(values)];
  const ids = unique(
    items.flatMap((item) => (item.variantId === undefined ? [] : [item.variantId])),
  );
  const skus = unique(
    items.flatMap((item) => (item.sku === undefined ? [] : [item.sku.trim().toLowerCase()])),
  );
  const barcodes = unique(
    items.flatMap((item) => (item.barcode === undefined ? [] : [item.barcode])),
  );

  const rows = await prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: actor.actorId, role: actor.actorRole });
    return tx.$queryRaw<
      {
        id: number;
        productId: number;
        sku: string | null;
        barcode: string | null;
        deleted: boolean;
      }[]
    >`
      select v.id, v."productId", lower(v.sku) as sku, v.barcode, v."deletedAt" is not null as deleted
      from cartlify.product_variants as v
      where v.id = any(${ids}::int[])
         or (v."deletedAt" is null
             and (lower(v.sku) = any(${skus}::text[]) or v.barcode = any(${barcodes}::text[])))
    `;
  });

  // a number and a barcode belong to the live variants only; a variant by its id may be taken out of sale
  const live = rows.filter((row) => !row.deleted);
  const byId = new Map(
    rows.filter((row) => opts.deleted || !row.deleted).map((row) => [row.id, row]),
  );
  const bySku = new Map(live.flatMap((row) => (row.sku === null ? [] : [[row.sku, row] as const])));
  const byBarcode = new Map(
    live.flatMap((row) => (row.barcode === null ? [] : [[row.barcode, row] as const])),
  );

  const variantIds = ids.filter((id) => !byId.has(id));
  const missingSkus = unique(
    items.flatMap((item) =>
      item.sku !== undefined && !bySku.has(item.sku.trim().toLowerCase()) ? [item.sku.trim()] : [],
    ),
  );
  const missingBarcodes = barcodes.filter((code) => !byBarcode.has(code));
  if (variantIds.length || missingSkus.length || missingBarcodes.length) {
    throw new NotFoundError('VARIANT_NOT_FOUND', {
      ...(variantIds.length ? { variantIds } : {}),
      ...(missingSkus.length ? { skus: missingSkus } : {}),
      ...(missingBarcodes.length ? { barcodes: missingBarcodes } : {}),
    });
  }

  return items.map((item) => {
    const { variantId: _id, sku: _sku, barcode: _barcode, ...rest } = item;
    const row =
      item.variantId !== undefined
        ? byId.get(item.variantId)!
        : item.sku !== undefined
          ? bySku.get(item.sku.trim().toLowerCase())!
          : byBarcode.get(item.barcode!)!;

    return { ...rest, variantId: row.id, productId: row.productId } as unknown as Omit<
      T,
      keyof StockVariantRefDto
    > & { variantId: number; productId: number };
  });
}

// the delivery as the database takes it: the cost and the last good day of an item, or of the
// delivery when the item has none of its own (an item with null for the last day has none whatever
// the delivery says); the items that have no cost in either place are 400 BATCH_UNIT_COST_REQUIRED
// with details.items, each with its place in the request and the way it names its variant. An item
// keeps the way it names its variant, the service turns that into an id
export function normalizeDeliveryInput(input: ReceiveStockDto, now = new Date()) {
  // the last good day by the calendar of the shop
  const today = shopToday(now.getTime());

  const missingCost = input.items.flatMap((item, index) =>
    item.unitCost === undefined && input.unitCost === undefined ? [{ index, ...refOf(item) }] : [],
  );
  if (missingCost.length)
    throw new BadRequestError('BATCH_UNIT_COST_REQUIRED', { items: missingCost });

  const costOf = (value: number) => {
    const cost = new Prisma.Decimal(value);
    if (cost.isNegative() || cost.decimalPlaces() > 2) {
      throw new BadRequestError('BATCH_UNIT_COST_INVALID');
    }
    return cost.toString();
  };
  const dayOf = (value: string | null | undefined) => {
    const day = value ?? null;
    if (day !== null && day < today) throw new BadRequestError('BATCH_EXPIRES_AT_INVALID');
    return day;
  };

  // the cost and the day of the delivery are checked whether or not an item takes them
  const sharedCost = input.unitCost === undefined ? undefined : costOf(input.unitCost);
  const sharedDay = dayOf(input.expiresAt);

  return {
    source: input.source,
    supplier: textOrNull(input.supplier),
    document: textOrNull(input.document),
    note: textOrNull(input.note),
    items: input.items.map((item): DeliveryFields & StockVariantRefDto => {
      const { variantId, sku, barcode } = item;

      return {
        ...(variantId !== undefined
          ? { variantId }
          : sku !== undefined
            ? { sku }
            : { barcode: barcode! }),
        quantity: item.quantity,
        unitCost: item.unitCost === undefined ? sharedCost! : costOf(item.unitCost),
        expiresAt: item.expiresAt === undefined ? sharedDay : dayOf(item.expiresAt),
        supplierBatchNumber: textOrNull(item.supplierBatchNumber),
      } as DeliveryFields & StockVariantRefDto;
    }),
  };
}

export type WriteOffFields = { quantity: number; batchId: number | null };
export type WriteOffItem = WriteOffFields & { variantId: number; productId: number };

export function normalizeWriteOffInput(input: WriteOffStockDto): {
  reason: WriteOffReason;
  note: string | null;
  items: Array<WriteOffFields & StockVariantRefDto>;
} {
  const note = textOrNull(input.note);

  // other says what it is in the note
  if (input.reason === 'other' && !note) throw new BadRequestError('WRITE_OFF_NOTE_REQUIRED');

  return {
    reason: input.reason,
    note,
    items: input.items.map((item) => ({
      ...refOf(item),
      quantity: item.quantity,
      batchId: item.batchId ?? null,
    })) as Array<WriteOffFields & StockVariantRefDto>,
  };
}

// the steps of a request in the order the rows of the variants are locked, the same order in every
// request, by the id of the variant; index is the place of the item in the request
export function deliverySteps<T extends { variantId: number }>(items: T[]) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.variantId - b.item.variantId || a.index - b.index);
}

// a batch named gives its units before the units of the same variant without one: those come from
// the batches in the order of a sale, and could take the units the batch named was asked for
export function writeOffSteps(items: WriteOffItem[]) {
  const named = (item: WriteOffItem) => (item.batchId === null ? 1 : 0);

  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        a.item.variantId - b.item.variantId || named(a.item) - named(b.item) || a.index - b.index,
    );
}

const sumBy = <K>(entries: [K, number][]) => {
  const sums = new Map<K, number>();
  for (const [key, n] of entries) sums.set(key, (sums.get(key) ?? 0) + n);
  return sums;
};

// the variants and batches of a write-off, read under the lock of the variants: every item names a
// variant there is, a batch of that variant, and asks no more than is free; the waiting orders
// hold their units, and only good ones: the good batches named by the items give no more than the
// good units no order holds (the units that are over, and the units without a batch, which take
// the ones that are over first, leave the reserve as it is). Every variant and batch short of
// units is named, the lines of one counted together
export function assertWriteOffFits(args: {
  items: WriteOffItem[];
  variants: Map<number, { stock: number; reservedStock: number }>;
  batches: Map<number, { variantId: number; remaining: number; expired: boolean }>;
  expired: Map<number, number>;
}): void {
  for (const item of args.items) {
    if (!args.variants.has(item.variantId)) {
      throw new NotFoundError('VARIANT_NOT_FOUND', { variantIds: [item.variantId] });
    }
    if (item.batchId !== null && args.batches.get(item.batchId)?.variantId !== item.variantId) {
      throw new NotFoundError('BATCH_NOT_FOUND', { batchId: item.batchId });
    }
  }

  const byVariant = sumBy(args.items.map((item) => [item.variantId, item.quantity]));
  const fromGoodBatches = sumBy(
    args.items.flatMap((item): [number, number][] =>
      item.batchId !== null && !args.batches.get(item.batchId)!.expired
        ? [[item.variantId, item.quantity]]
        : [],
    ),
  );
  const shortVariants = [...byVariant]
    .sort(([a], [b]) => a - b)
    .map(([variantId, requested]) => {
      const { stock, reservedStock } = args.variants.get(variantId)!;
      const free = { variantId, available: Math.max(0, stock - reservedStock), requested };
      if (free.requested > free.available) return free;

      // the good units of the named good batches
      const good = fromGoodBatches.get(variantId) ?? 0;
      const goodFree = Math.max(0, stock - (args.expired.get(variantId) ?? 0) - reservedStock);
      return { variantId, available: goodFree, requested: good };
    })
    .filter((line) => line.requested > line.available);
  if (shortVariants.length) {
    throw new ConflictError('INSUFFICIENT_AVAILABLE_STOCK', { variants: shortVariants });
  }

  const byBatch = sumBy(
    args.items.flatMap((item): [number, number][] =>
      item.batchId === null ? [] : [[item.batchId, item.quantity]],
    ),
  );
  const shortBatches = [...byBatch]
    .sort(([a], [b]) => a - b)
    .map(([batchId, requested]) => ({
      batchId,
      remaining: args.batches.get(batchId)!.remaining,
      requested,
    }))
    .filter((line) => line.requested > line.remaining);
  if (shortBatches.length) {
    throw new ConflictError('BATCH_INSUFFICIENT', { batches: shortBatches });
  }
}

// the stock of each variant of a request after it, by id: the free units, the whole stock, what the
// waiting orders hold and the units of batches that are over, the way the admin card shows them
export function stockSummaryOf(
  rows: { id: number; productId: number; stock: number; reservedStock: number }[],
  expired: Map<number, number>,
): StockVariantSummaryDto[] {
  return [...rows]
    .sort((a, b) => a.id - b.id)
    .map((row) => {
      const expiredStock = expired.get(row.id) ?? 0;
      return {
        variantId: row.id,
        productId: row.productId as ProductId,
        stock: freeUnits(row.stock, row.reservedStock, expiredStock),
        totalStock: row.stock,
        reservedStock: row.reservedStock,
        expiredStock,
      };
    });
}

type Db = Pick<Prisma.TransactionClient, 'productVariant' | '$queryRaw'>;

// the product and the variant of each line of an answer, by name, by the id of the variant
export async function stockRefsOf(
  db: Db,
  variantIds: readonly number[],
): Promise<Map<number, StockLineRefDto>> {
  const rows = await db.productVariant.findMany({
    where: { id: { in: [...new Set(variantIds)] } },
    select: {
      id: true,
      productId: true,
      position: true,
      sku: true,
      product: { select: { name: true } },
    },
  });

  const names = await variantNamesOf(
    db,
    rows.map((row) => row.id),
  );

  return new Map(
    rows.map((row) => [
      row.id,
      {
        productId: row.productId as ProductId,
        variantId: row.id,
        product: { id: row.productId as ProductId, name: row.product.name },
        variant: {
          id: row.id,
          position: row.position,
          name: names.get(row.id)?.name ?? row.product.name,
          sku: row.sku,
        },
      },
    ]),
  );
}

// the codes the stock functions of the database raise, as the answers of the api; the server
// checks first, so these come only from a change between its check and the function
const STOCK_DB_ERRORS: Record<string, () => AppError> = {
  BATCH_UNIT_COST_INVALID: () => new BadRequestError('BATCH_UNIT_COST_INVALID'),
  BATCH_EXPIRES_AT_INVALID: () => new BadRequestError('BATCH_EXPIRES_AT_INVALID'),
  WRITE_OFF_NOTE_REQUIRED: () => new BadRequestError('WRITE_OFF_NOTE_REQUIRED'),
  INSUFFICIENT_AVAILABLE_STOCK: () => new ConflictError('INSUFFICIENT_AVAILABLE_STOCK'),
  BATCH_INSUFFICIENT: () => new ConflictError('BATCH_INSUFFICIENT'),
  BATCH_NOT_FOUND: () => new NotFoundError('BATCH_NOT_FOUND'),
};

// the error of a stock function as the answer for the item of the request it stopped at
export function stockErrorOf(err: unknown, item: { variantId: number }): AppError | null {
  const message = String(getPgMessage(err) ?? '');

  if (message.includes('VARIANT_NOT_FOUND')) {
    return new NotFoundError('VARIANT_NOT_FOUND', { variantIds: [item.variantId] });
  }

  for (const [code, toError] of Object.entries(STOCK_DB_ERRORS)) {
    if (message.includes(code)) return toError();
  }

  // a check of a column (the number of the supplier over 100 characters gets here only past the
  // schema of the request)
  if (getPgCode(err) === '23514') return new BadRequestError('STOCK_VALUE_INVALID');

  return null;
}

import { Prisma } from '@prisma/client';

import { getPgCode, getPgMessage, prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { freeUnits } from '@db/expiredStock.helper.js';
import { shopToday } from '@helpers/shopDay.js';
import { BadRequestError, ConflictError, NotFoundError, type AppError } from '@utils/errors.js';

import type {
  DeliveryBodyDto,
  StockProductRefDto,
  StockProductSummaryDto,
  WriteOffBodyDto,
  WriteOffReason,
} from 'types/dto/products.dto.js';
import type { ProductId, UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// a delivery takes in a batch of each of its items at its cost of a unit, in the currency of the
// shop; a write-off takes free units of a product, from the batch named or from the batches in
// the order of a sale (the one that ends first, then the oldest). The functions of the database
// do both and check it all again (cartlify.receive_product_batch, write_off_product_stock, db/05);
// the server says first what the admin asked that cannot be done

const textOrNull = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export type DeliveryItem = {
  productId: number;
  quantity: number;
  // a decimal string to the cent, as the database takes it
  unitCost: string;
  // the last good day, yyyy-mm-dd
  expiresAt: string | null;
  supplierBatchNumber: string | null;
};

// the items of a request with the id of their product: an item that names its product by the
// article number gets the id of the product of the catalog that has it, whatever the case of its
// letters. Numbers no product of the catalog has are 404 PRODUCT_NOT_FOUND with details.skus, and
// nothing is taken in or written off
export async function withProductIds<T extends object>(
  items: Array<T & StockProductRefDto>,
  actor: { actorId: UserId; actorRole: Role },
): Promise<Array<T & { productId: ProductId }>> {
  const skus = [
    ...new Set(items.flatMap((item) => (item.sku === undefined ? [] : [item.sku.trim()]))),
  ];
  if (!skus.length) return items as Array<T & { productId: ProductId }>;

  const rows = await prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: actor.actorId, role: actor.actorRole });
    return tx.$queryRaw<{ id: number; sku: string }[]>`
      select id, lower(sku) as sku
      from cartlify.products
      where "deletedAt" is null and lower(sku) = any(${skus.map((sku) => sku.toLowerCase())}::text[])
    `;
  });
  const idOf = new Map(rows.map((row) => [row.sku, row.id]));

  const missing = skus.filter((sku) => !idOf.has(sku.toLowerCase()));
  if (missing.length) throw new NotFoundError('PRODUCT_NOT_FOUND', { skus: missing });

  return items.map((item) => {
    if (item.sku === undefined) return item as T & { productId: ProductId };
    const { sku, ...rest } = item;
    return { ...rest, productId: idOf.get(sku.trim().toLowerCase())! } as unknown as T & {
      productId: ProductId;
    };
  });
}

export function normalizeDeliveryInput(input: DeliveryBodyDto, now = new Date()) {
  // the last good day by the calendar of the shop
  const today = shopToday(now.getTime());

  return {
    source: input.source,
    supplier: textOrNull(input.supplier),
    document: textOrNull(input.document),
    note: textOrNull(input.note),
    items: input.items.map((item): DeliveryItem => {
      const cost = new Prisma.Decimal(item.unitCost);
      if (cost.isNegative() || cost.decimalPlaces() > 2) {
        throw new BadRequestError('BATCH_UNIT_COST_INVALID');
      }

      const expiresAt = item.expiresAt ?? null;
      if (expiresAt !== null && expiresAt < today) {
        throw new BadRequestError('BATCH_EXPIRES_AT_INVALID');
      }

      return {
        productId: item.productId,
        quantity: item.quantity,
        unitCost: cost.toString(),
        expiresAt,
        supplierBatchNumber: textOrNull(item.supplierBatchNumber),
      };
    }),
  };
}

export type WriteOffItem = { productId: number; quantity: number; batchId: number | null };

export function normalizeWriteOffInput(input: WriteOffBodyDto): {
  reason: WriteOffReason;
  note: string | null;
  items: WriteOffItem[];
} {
  const note = textOrNull(input.note);

  // other says what it is in the note
  if (input.reason === 'other' && !note) throw new BadRequestError('WRITE_OFF_NOTE_REQUIRED');

  return {
    reason: input.reason,
    note,
    items: input.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      batchId: item.batchId ?? null,
    })),
  };
}

// the steps of a request in the order the rows of the products are locked, the same order in every
// request, by the id of the product; index is the place of the item in the request
export function deliverySteps<T extends { productId: number }>(items: T[]) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.productId - b.item.productId || a.index - b.index);
}

// a batch named gives its units before the units of the same product without one: those come from
// the batches in the order of a sale, and could take the units the batch named was asked for
export function writeOffSteps(items: WriteOffItem[]) {
  const named = (item: WriteOffItem) => (item.batchId === null ? 1 : 0);

  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        a.item.productId - b.item.productId || named(a.item) - named(b.item) || a.index - b.index,
    );
}

const sumBy = <K>(entries: [K, number][]) => {
  const sums = new Map<K, number>();
  for (const [key, n] of entries) sums.set(key, (sums.get(key) ?? 0) + n);
  return sums;
};

// the products and batches of a write-off, read under the lock of the products: every item names
// a product there is, a batch of that product, and asks no more than is free; the waiting orders
// hold their units, and only good ones: the good batches named by the items give no more than the
// good units no order holds (the units that are over, and the units without a batch, which take
// the ones that are over first, leave the reserve as it is). Every product and batch short of
// units is named, the lines of one counted together
export function assertWriteOffFits(args: {
  items: WriteOffItem[];
  products: Map<number, { stock: number; reservedStock: number }>;
  batches: Map<number, { productId: number; remaining: number; expired: boolean }>;
  expired: Map<number, number>;
}): void {
  for (const item of args.items) {
    if (!args.products.has(item.productId)) {
      throw new NotFoundError('PRODUCT_NOT_FOUND', { productId: item.productId });
    }
    if (item.batchId !== null && args.batches.get(item.batchId)?.productId !== item.productId) {
      throw new NotFoundError('BATCH_NOT_FOUND', { batchId: item.batchId });
    }
  }

  const byProduct = sumBy(args.items.map((item) => [item.productId, item.quantity]));
  const fromGoodBatches = sumBy(
    args.items.flatMap((item): [number, number][] =>
      item.batchId !== null && !args.batches.get(item.batchId)!.expired
        ? [[item.productId, item.quantity]]
        : [],
    ),
  );
  const shortProducts = [...byProduct]
    .sort(([a], [b]) => a - b)
    .map(([productId, requested]) => {
      const { stock, reservedStock } = args.products.get(productId)!;
      const free = { productId, available: Math.max(0, stock - reservedStock), requested };
      if (free.requested > free.available) return free;

      // the good units of the named good batches
      const good = fromGoodBatches.get(productId) ?? 0;
      const goodFree = Math.max(0, stock - (args.expired.get(productId) ?? 0) - reservedStock);
      return { productId, available: goodFree, requested: good };
    })
    .filter((line) => line.requested > line.available);
  if (shortProducts.length) {
    throw new ConflictError('INSUFFICIENT_AVAILABLE_STOCK', { products: shortProducts });
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

// the stock of each product of a request after it, by id: the free units, the whole stock, what
// the waiting orders hold and the units of batches that are over, the way the admin card shows them
export function stockSummaryOf(
  rows: { id: number; stock: number; reservedStock: number }[],
  expired: Map<number, number>,
): StockProductSummaryDto[] {
  return [...rows]
    .sort((a, b) => a.id - b.id)
    .map((row) => {
      const expiredStock = expired.get(row.id) ?? 0;
      return {
        id: row.id as StockProductSummaryDto['id'],
        stock: freeUnits(row.stock, row.reservedStock, expiredStock),
        totalStock: row.stock,
        reservedStock: row.reservedStock,
        expiredStock,
      };
    });
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
export function stockErrorOf(err: unknown, item: { productId: number }): AppError | null {
  const message = String(getPgMessage(err) ?? '');

  if (message.includes('PRODUCT_NOT_FOUND')) {
    return new NotFoundError('PRODUCT_NOT_FOUND', { productId: item.productId });
  }

  for (const [code, toError] of Object.entries(STOCK_DB_ERRORS)) {
    if (message.includes(code)) return toError();
  }

  // a check of a column (the number of the supplier over 100 characters gets here only past the
  // schema of the request)
  if (getPgCode(err) === '23514') return new BadRequestError('STOCK_VALUE_INVALID');

  return null;
}

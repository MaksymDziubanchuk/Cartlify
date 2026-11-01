import type { Prisma } from '@prisma/client';

import { ConflictError, isAppError } from '@utils/errors.js';

import { refusalOfVariants } from './variantChange.helper.js';
import { knownVariantDbError, lockGalleryImages, movedOrder } from './variantWrite.helper.js';

type Tx = Prisma.TransactionClient;

// the variants given more than once, each once, in the order they first come back
export function repeatedVariantIds(ids: readonly number[]): number[] {
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

// ---- the pictures of the variants of a batch ----

// Locks the pictures that the items name in the galleries of their products (asked: the product to
// the ids of the pictures its items name) until the end of the transaction, and gives the ones that
// are there, by product. The products go by id and the pictures of each by id, so two requests that
// lock them wait for each other in one order. The rows of the variants are locked before
export async function lockGalleries(
  tx: Tx,
  asked: ReadonlyMap<number, ReadonlySet<number>>,
): Promise<Map<number, Set<number>>> {
  const found = new Map<number, Set<number>>();

  for (const productId of [...asked.keys()].sort((a, b) => a - b)) {
    found.set(productId, await lockGalleryImages(tx, productId, [...asked.get(productId)!]));
  }

  return found;
}

// ---- the codes of the variants of a batch ----

// a code an item asks for, as sent: the item's variant and the article number or the barcode
export type CodeAsk = { variantId: number; code: string };

// Which asks are taken, by their index: a live variant other than the one of the ask holds the code
// now (holders: the code, folded, to the ids of the live variants that have it), or another ask of
// the batch wants the same code. The codes are unique and checked on every write, so a code a
// variant of the batch holds now is taken even when that variant gives it up in the same batch: two
// variants cannot swap codes in one request. fold says when two codes are the same (an article
// number whatever the case of its letters)
export function takenAsks(
  asks: readonly CodeAsk[],
  holders: ReadonlyMap<string, ReadonlySet<number>>,
  fold: (code: string) => string,
): number[] {
  const asked = new Map<string, number>();
  for (const ask of asks) asked.set(fold(ask.code), (asked.get(fold(ask.code)) ?? 0) + 1);

  return asks.flatMap((ask, index) => {
    const code = fold(ask.code);
    const held = [...(holders.get(code) ?? [])].some((id) => id !== ask.variantId);

    return held || asked.get(code)! > 1 ? [index] : [];
  });
}

// The codes the items change are free: no live variant of the catalog other than the item's has
// them, and no two items ask for the same one. Only the items that change a code of a live variant
// are asked about (a variant out of sale holds none, the check comes when it is put back). 409
// PRODUCT_SKU_TAKEN or VARIANT_BARCODE_TAKEN names the items in trouble, in the order of the request
// (details.variants: the variant and the code it asked)
export async function assertBatchCodesFree(
  tx: Tx,
  asks: ReadonlyArray<{
    variantId: number;
    sku?: string | null | undefined;
    barcode?: string | null | undefined;
  }>,
): Promise<void> {
  const skuAsks = asks.flatMap((ask) =>
    ask.sku ? [{ variantId: ask.variantId, code: ask.sku }] : [],
  );
  const barcodeAsks = asks.flatMap((ask) =>
    ask.barcode ? [{ variantId: ask.variantId, code: ask.barcode }] : [],
  );

  const holdersOf = (rows: ReadonlyArray<{ id: number; code: string }>) => {
    const held = new Map<string, Set<number>>();
    for (const row of rows) held.set(row.code, (held.get(row.code) ?? new Set()).add(row.id));

    return held;
  };

  if (skuAsks.length) {
    const skus = [...new Set(skuAsks.map((ask) => ask.code.toLowerCase()))];
    const rows = await tx.$queryRaw<{ id: number; code: string }[]>`
      select id, lower(sku) as code from cartlify.product_variants
      where "deletedAt" is null and lower(sku) = any(${skus}::text[])
    `;

    const taken = takenAsks(skuAsks, holdersOf(rows), (code) => code.toLowerCase());
    if (taken.length) {
      throw new ConflictError('PRODUCT_SKU_TAKEN', {
        variants: taken.map((index) => ({
          variantId: skuAsks[index]!.variantId,
          sku: skuAsks[index]!.code,
        })),
      });
    }
  }

  if (barcodeAsks.length) {
    const barcodes = [...new Set(barcodeAsks.map((ask) => ask.code))];
    const rows = await tx.$queryRaw<{ id: number; code: string }[]>`
      select id, barcode as code from cartlify.product_variants
      where "deletedAt" is null and barcode = any(${barcodes}::text[])
    `;

    const taken = takenAsks(barcodeAsks, holdersOf(rows), (code) => code);
    if (taken.length) {
      throw new ConflictError('VARIANT_BARCODE_TAKEN', {
        variants: taken.map((index) => ({
          variantId: barcodeAsks[index]!.variantId,
          barcode: barcodeAsks[index]!.code,
        })),
      });
    }
  }
}

// ---- the places of the variants of a batch ----

// a variant put at a place among the variants of its product
export type Move = { productId: number; variantId: number; position: number };

// The order of the variants of each product (the ones taken out of sale too) after the moves, taken
// one after the other in the order given: what each move leaves is what the next one starts from
// (a move of the same variant again puts it at the new place). Gives only the products moved
export function orderAfterMoves(
  orders: ReadonlyMap<number, readonly number[]>,
  moves: readonly Move[],
): Map<number, number[]> {
  const result = new Map<number, number[]>();

  for (const move of moves) {
    const order = result.get(move.productId) ?? [...(orders.get(move.productId) ?? [])];
    result.set(move.productId, movedOrder(order, move.variantId, move.position));
  }

  return result;
}

// the order of the variants of the products now, each by its place and then its id: what a move
// starts from (moveVariant reads the same order)
export async function readVariantOrders(
  tx: Tx,
  productIds: readonly number[],
): Promise<Map<number, number[]>> {
  const orders = new Map<number, number[]>();
  if (!productIds.length) return orders;

  const rows = await tx.productVariant.findMany({
    where: { productId: { in: [...productIds] } },
    select: { id: true, productId: true },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  for (const row of rows) {
    orders.set(row.productId, [...(orders.get(row.productId) ?? []), row.id]);
  }

  return orders;
}

// A write the database refused names its variant: an end of a new sale already behind by the clock
// of the database. Any other failure goes on as it is, the transaction repeats on a busy row
export async function refuseWrite(variantId: number, err: unknown): Promise<unknown> {
  if (isAppError(err)) return refusalOfVariants([{ variantId, err }]);

  const known = await knownVariantDbError(err);
  return known ? refusalOfVariants([{ variantId, err: known }]) : err;
}

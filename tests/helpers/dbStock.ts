import { randomUUID } from 'node:crypto';

import type { Actor, DbSession } from './db.js';

// the batches and the stock of a variant for the tests of the database rules (tests/integration/db),
// inside the rolled-back transaction of inRolledBackTx: a batch taken in through
// cartlify.receive_variant_batch and units written off through cartlify.write_off_variant_stock,
// the way the routes of the admin call them. A product has its stock in its variants: the functions
// here take the id of a variant

export type Batch = {
  id: number;
  source: string;
  supplierBatchNumber: string | null;
  unitCost: string;
  quantity: number;
  remaining: number;
  expiresAt: string | null;
};

export type ReceiveArgs = {
  deliveryId?: string;
  source?: string;
  quantity?: number;
  unitCost?: string;
  expiresAt?: string | null;
  supplierBatchNumber?: string | null;
  supplier?: string | null;
  document?: string | null;
  note?: string | null;
};

// a batch taken in by the actor, an admin by default; the outcome keeps the error it stopped with
export async function receive(
  db: DbSession,
  actor: Actor,
  variantId: number,
  args: ReceiveArgs = {},
) {
  await db.as(actor);
  return db.attempt<{ id: number }>(
    `select cartlify.receive_variant_batch(
       $1::uuid, $2::int, $3::cartlify."StockSource", $4::int, $5::numeric, $6::date, $7, $8, $9, $10
     ) as id`,
    args.deliveryId ?? randomUUID(),
    variantId,
    args.source ?? 'supplier',
    args.quantity ?? 5,
    args.unitCost ?? '2.50',
    args.expiresAt ?? null,
    args.supplierBatchNumber ?? null,
    args.supplier ?? null,
    args.document ?? null,
    args.note ?? null,
  );
}

// the id of a batch taken in, or the error it stopped with
export async function batchIdOf(
  db: DbSession,
  actor: Actor,
  variantId: number,
  args: ReceiveArgs = {},
): Promise<number> {
  const outcome = await receive(db, actor, variantId, args);
  if (!outcome.ok) throw new Error(`receive_variant_batch refused: ${outcome.message}`);
  return outcome.rows[0]!.id;
}

export type WriteOffArgs = {
  writeOffId?: string;
  batchId?: number | null;
  quantity?: number;
  reason?: string;
  note?: string | null;
};

export async function writeOff(
  db: DbSession,
  actor: Actor,
  variantId: number,
  args: WriteOffArgs = {},
) {
  await db.as(actor);
  return db.attempt<{ taken: { batchId: number; quantity: number; unitCost: string }[] }>(
    `select cartlify.write_off_variant_stock($1::uuid, $2::int, $3::int, $4::int, $5, $6) as taken`,
    args.writeOffId ?? randomUUID(),
    variantId,
    args.batchId ?? null,
    args.quantity ?? 1,
    args.reason ?? 'damaged',
    args.note ?? null,
  );
}

// the batches of a variant as an admin reads them, the oldest first
export async function batchesOf(db: DbSession, adminId: number, variantId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.rows<Batch>(
    `select id, source::text as source, "supplierBatchNumber", "unitCost"::text as "unitCost",
            quantity, remaining, to_char("expiresAt", 'YYYY-MM-DD') as "expiresAt"
     from cartlify.product_batches where "variantId" = $1 order by id`,
    variantId,
  );
}

// what a paid order took from each batch, by variant and batch
export async function allocationsOf(db: DbSession, adminId: number, orderId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.rows<{ productId: number; variantId: number; batchId: number; quantity: number }>(
    `select "productId", "variantId", "batchId", quantity
     from cartlify.order_batch_allocations where "orderId" = $1 order by "variantId", "batchId"`,
    orderId,
  );
}

export type StockLogLine = {
  id: number;
  actorId: number | null;
  actorRole: string | null;
  productId: number;
  variantId: number;
  event: string;
  quantityChange: number;
  stockAfter: number;
  meta: { field: string; old: unknown; new: unknown }[] | null;
  deliveryId: string | null;
  writeOffId: string | null;
  orderId: number | null;
};

const STOCK_LOG_COLUMNS = `id, "actorId", "actorRole"::text as "actorRole", "productId", "variantId", event,
  "quantityChange", "stockAfter", meta, "deliveryId"::text as "deliveryId",
  "writeOffId"::text as "writeOffId", "orderId"`;

// the lines of the stock log of a variant, the oldest first, as an admin reads them; one event
// when given
export async function stockLogOf(
  db: DbSession,
  adminId: number,
  variantId: number,
  event?: string,
) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.rows<StockLogLine>(
    `select ${STOCK_LOG_COLUMNS}
     from cartlify.stock_log
     where "variantId" = $1 and ($2::text is null or event = $2)
     order by id`,
    variantId,
    event ?? null,
  );
}

// the lines of the stock log that carry one operation id (a delivery, a write-off or an order), the
// oldest first
export async function stockLogOfOperation(
  db: DbSession,
  adminId: number,
  column: 'deliveryId' | 'writeOffId' | 'orderId',
  id: string | number,
) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.rows<StockLogLine>(
    `select ${STOCK_LOG_COLUMNS}
     from cartlify.stock_log
     where "${column}" = $1::${column === 'orderId' ? 'int' : 'uuid'}
     order by id`,
    id,
  );
}

// the lines of the admin log about the stock of a variant: the database writes none, the server
// writes one line for a whole delivery or write-off (src/routes/api/products/services)
export async function adminStockLinesOf(db: DbSession, adminId: number, variantId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.rows<{ id: number }>(
    `select id from cartlify.admin_audit_log
     where "entityType" = 'variant' and "entityId" = $1
       and action in ('STOCK_DELIVERY', 'STOCK_WRITE_OFF')`,
    variantId,
  );
}

// the value of one field of the changes of a line of the log
export const fieldOf = (line: { meta: StockLogLine['meta'] } | undefined, field: string) =>
  line?.meta?.find((change) => change.field === field)?.new;

// runs the checks the database keeps for the end of the transaction now: the stock of every
// variant changed is what its batches have left
export const checkDeferredNow = (db: DbSession) => db.attempt('set constraints all immediate');

// today and other days by the calendar of utc, yyyy-mm-dd
export const utcDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

// the day of the shop for the rest of the transaction, the way the context of the app sets it:
// a batch whose last good day is before it is over
export const setShopDay = (db: DbSession, day: string) =>
  db.rows(`select set_config('cartlify.shop_today', $1, true) as day`, day);

// the units of a variant in batches that are over, as the database counts them
export async function expiredUnitsOf(db: DbSession, variantId: number) {
  const [row] = await db.rows<{ n: number }>(
    'select cartlify.variant_expired_units($1::int) as n',
    variantId,
  );
  return row!.n;
}

// a day after the one given, yyyy-mm-dd
export const dayAfter = (day: string, days = 1) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

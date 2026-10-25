import { randomUUID } from 'node:crypto';

import type { Actor, DbSession } from './db.js';

// the batches and the stock of a product for the tests of the database rules (tests/integration/db),
// inside the rolled-back transaction of inRolledBackTx: a batch taken in through
// cartlify.receive_product_batch and units written off through cartlify.write_off_product_stock,
// the way the routes of the admin call them

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
  productId: number,
  args: ReceiveArgs = {},
) {
  await db.as(actor);
  return db.attempt<{ id: number }>(
    `select cartlify.receive_product_batch(
       $1::uuid, $2::int, $3::cartlify."StockSource", $4::int, $5::numeric, $6::date, $7, $8, $9, $10
     ) as id`,
    args.deliveryId ?? randomUUID(),
    productId,
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
  productId: number,
  args: ReceiveArgs = {},
): Promise<number> {
  const outcome = await receive(db, actor, productId, args);
  if (!outcome.ok) throw new Error(`receive_product_batch refused: ${outcome.message}`);
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
  productId: number,
  args: WriteOffArgs = {},
) {
  await db.as(actor);
  return db.attempt<{ taken: { batchId: number; quantity: number; unitCost: string }[] }>(
    `select cartlify.write_off_product_stock($1::uuid, $2::int, $3::int, $4::int, $5, $6) as taken`,
    args.writeOffId ?? randomUUID(),
    productId,
    args.batchId ?? null,
    args.quantity ?? 1,
    args.reason ?? 'damaged',
    args.note ?? null,
  );
}

// the batches of a product as an admin reads them, the oldest first
export async function batchesOf(db: DbSession, adminId: number, productId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.rows<Batch>(
    `select id, source::text as source, "supplierBatchNumber", "unitCost"::text as "unitCost",
            quantity, remaining, to_char("expiresAt", 'YYYY-MM-DD') as "expiresAt"
     from cartlify.product_batches where "productId" = $1 order by id`,
    productId,
  );
}

// what a paid order took from each batch, by batch
export async function allocationsOf(db: DbSession, adminId: number, orderId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.rows<{ productId: number; batchId: number; quantity: number }>(
    `select "productId", "batchId", quantity
     from cartlify.order_batch_allocations where "orderId" = $1 order by "productId", "batchId"`,
    orderId,
  );
}

export type StockLine = {
  actorId: number;
  actorRole: string;
  meta: { field: string; old: unknown; new: unknown }[];
};

// the lines of the admin log of the stock of a product, the oldest first
export async function stockLinesOf(
  db: DbSession,
  adminId: number,
  productId: number,
  action: 'STOCK_DELIVERY' | 'STOCK_WRITE_OFF',
) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.rows<StockLine>(
    `select "actorId", "actorRole"::text as "actorRole", meta
     from cartlify.admin_audit_log
     where "entityType" = 'product' and "entityId" = $1 and action = $2::cartlify."AdminAuditAction"
     order by id`,
    productId,
    action,
  );
}

// the value of one field of a line of the log
export const fieldOf = (line: StockLine | undefined, field: string) =>
  line?.meta.find((change) => change.field === field)?.new;

// runs the checks the database keeps for the end of the transaction now: the stock of every
// product changed is what its batches have left
export const checkDeferredNow = (db: DbSession) => db.attempt('set constraints all immediate');

// today and other days by the calendar of utc, yyyy-mm-dd
export const utcDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

// the day of the shop for the rest of the transaction, the way the context of the app sets it:
// a batch whose last good day is before it is over
export const setShopDay = (db: DbSession, day: string) =>
  db.rows(`select set_config('cartlify.shop_today', $1, true) as day`, day);

// the units of a product in batches that are over, as the database counts them
export async function expiredUnitsOf(db: DbSession, productId: number) {
  const [row] = await db.rows<{ n: number }>(
    'select cartlify.product_expired_units($1::int) as n',
    productId,
  );
  return row!.n;
}

// a day after the one given, yyyy-mm-dd
export const dayAfter = (day: string, days = 1) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

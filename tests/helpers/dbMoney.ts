import { randomUUID } from 'node:crypto';

import type { Actor, DbSession, Outcome } from './db.js';

// The money of an order in the database, for the tests of the payments (the disputes of
// a payment, the holds of an order, the refunds made by hand in the dashboard of the provider and
// what root decides on them, the cost of a send): the calls the webhook, the worker, an admin and
// root make, each run as the actor given inside the rolled-back transaction of inRolledBackTx, and
// what an admin reads of what they wrote. The orders come from dbOrders.ts: paidOrderOf pays through
// pay_order, which writes the lines of the payment, and the id of the payment is pi_db_<order id>.

// what a function of the money answers
export type Answer = Record<string, unknown>;

// the server acting by itself: the webhook and the worker (the admin context without a user id)
export const SYSTEM: Actor = { role: 'ADMIN' };

// a statement run as the actor given, refused or not
export async function call<T = Record<string, unknown>>(
  db: DbSession,
  actor: Actor,
  statement: string,
  ...values: unknown[]
): Promise<Outcome<T>> {
  await db.as(actor);
  return db.attempt<T>(statement, ...values);
}

// the answer of a function that has to work, called as `select ... as result`
export async function answerOf(
  db: DbSession,
  actor: Actor,
  statement: string,
  ...values: unknown[]
): Promise<Answer> {
  const outcome = await call<{ result: Answer }>(db, actor, statement, ...values);
  if (!outcome.ok) throw new Error(`${statement.slice(0, 60)} refused: ${outcome.message}`);
  return outcome.rows[0]!.result;
}

// ---------------------------------------------------------------------------------------------
// the disputes
// ---------------------------------------------------------------------------------------------

export type DisputeStatus =
  | 'warning_needs_response'
  | 'warning_under_review'
  | 'warning_closed'
  | 'needs_response'
  | 'under_review'
  | 'won'
  | 'lost'
  | 'prevented';

// the statuses that end a dispute; the others are open
export const ENDED: DisputeStatus[] = ['warning_closed', 'won', 'lost', 'prevented'];

// a balance transaction of a dispute the way the app hands it on: the amount in the currency of the
// payment (the app turns the cents of the provider into it) with the sign of the provider (below 0
// the bank took the money from the shop), the fee of the provider apart
export type DisputeTx = { id: string; amount: number; fee?: number; currency?: string };

// a dispute as the provider gives it at the moment the app reads it (a snapshot); what is not said
// takes the defaults below
export type Snapshot = {
  stripeId: string;
  paymentId: string;
  status: DisputeStatus | null;
  reason?: string | null;
  dueBy?: string | null;
  hasEvidence?: boolean;
  submissions?: number;
  refundable?: boolean;
  openedAt?: string | null;
  closedAt?: string | null;
  transactions?: DisputeTx[];
  // the transactions as raw json, for a snapshot that is not whole
  rawTransactions?: string | null;
};

// the times of the provider, utc without a zone as the columns hold them
export const OPENED_AT = '2026-11-01 10:00:00';
export const DUE_BY = '2026-11-25 23:59:59';
export const CLOSED_AT = '2026-11-10 12:00:00';

export const newDisputeId = () => `dp_${randomUUID()}`;
const newTxId = () => `txn_${randomUUID()}`;

// what the bank takes from the shop when a dispute opens (the fee of the dispute is apart), and
// what it gives back when the shop wins
export const withdrawal = (amount: number): DisputeTx => ({
  id: newTxId(),
  amount: -amount,
  fee: 15,
  currency: 'eur',
});
export const reinstatement = (amount: number): DisputeTx => ({
  id: newTxId(),
  amount,
  fee: 0,
  currency: 'eur',
});

const SYNC = `select cartlify.sync_payment_dispute(
  'stripe'::cartlify."PaymentProvider", $1, $2, $3::cartlify."DisputeStatus", $4, $5::timestamp,
  $6::boolean, $7::int, $8::boolean, $9::timestamp, $10::timestamp, $11::jsonb
) as result`;

function syncValues(s: Snapshot): unknown[] {
  const ended = s.status !== null && ENDED.includes(s.status);
  let transactions: string | null = JSON.stringify(s.transactions ?? []);
  if (s.rawTransactions !== undefined) transactions = s.rawTransactions;

  return [
    s.stripeId,
    s.paymentId,
    s.status,
    s.reason === undefined ? 'fraudulent' : s.reason,
    s.dueBy === undefined ? (ended ? null : DUE_BY) : s.dueBy,
    s.hasEvidence ?? false,
    s.submissions ?? 0,
    s.refundable ?? false,
    s.openedAt === undefined ? OPENED_AT : s.openedAt,
    s.closedAt === undefined ? (ended ? CLOSED_AT : null) : s.closedAt,
    transactions,
  ];
}

// the sync the webhook and the worker make, as the actor given (the system unless said)
export const syncOf = (db: DbSession, s: Snapshot, actor: Actor = SYSTEM) =>
  call<{ result: Answer }>(db, actor, SYNC, ...syncValues(s));

// the same, and it has to work
export const synced = (db: DbSession, s: Snapshot) => answerOf(db, SYSTEM, SYNC, ...syncValues(s));

export type DisputeRow = {
  id: number;
  provider: string;
  stripeId: string;
  paymentId: string;
  orderId: number | null;
  userId: number | null;
  reason: string | null;
  status: string;
  evidenceDueBy: string | null;
  hasEvidence: boolean;
  submissionCount: number;
  isChargeRefundable: boolean;
  openedAt: string;
  closedAt: string | null;
  draftedAt: string | null;
  // the time of the database at the read, to the millisecond, utc without a zone
  now: string;
};

// the disputes of a payment as an admin reads them, oldest first
export async function disputesOf(db: DbSession, adminId: number, paymentId: string) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.rows<DisputeRow>(
    `select id, provider::text as provider, "stripeId", "paymentId", "orderId", "userId", reason,
            status::text as status, "evidenceDueBy"::text as "evidenceDueBy", "hasEvidence",
            "submissionCount", "isChargeRefundable", "openedAt"::text as "openedAt",
            "closedAt"::text as "closedAt", "draftedAt"::text as "draftedAt",
            (now() at time zone 'UTC')::timestamp(3)::text as now
     from cartlify.payment_disputes where "paymentId" = $1 order by id`,
    paymentId,
  );
}

// ---------------------------------------------------------------------------------------------
// the holds of an order
// ---------------------------------------------------------------------------------------------

export type Hold = { reason: string; since: string; ref: unknown };

// what holds the order back from its sending, as an admin reads it
export async function holdsOf(db: DbSession, adminId: number, orderId: number): Promise<Hold[]> {
  await db.as({ role: 'ADMIN', userId: adminId });
  const [row] = await db.rows<{ holds: Hold[] }>(
    'select holds from cartlify.orders where id = $1',
    orderId,
  );
  return row!.holds;
}

// the reasons and what each names, the time left out
export const reasonsOf = (holds: Hold[]) => holds.map((h) => [h.reason, h.ref]);

// the order as an admin reads it: its status and the mark of a warning on a sent order
export async function orderOf(db: DbSession, adminId: number, orderId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  const [row] = await db.rows<{ status: string; fraudWarnedAt: string | null; now: string }>(
    `select status::text as status, "fraudWarnedAt"::text as "fraudWarnedAt",
            (now() at time zone 'UTC')::timestamp(3)::text as now
     from cartlify.orders where id = $1`,
    orderId,
  );
  return row!;
}

// an admin takes the step to shipped (and on to delivered), the way the route does
export async function stepOf(
  db: DbSession,
  adminId: number,
  orderId: number,
  // paid: the send taken back
  status: 'paid' | 'shipped' | 'delivered',
) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.attempt(
    `update cartlify.orders set status = $2::cartlify."OrderStatus" where id = $1 returning id`,
    orderId,
    status,
  );
}

// ---------------------------------------------------------------------------------------------
// the money journal
// ---------------------------------------------------------------------------------------------

export type Line = {
  id: number;
  event: string;
  purpose: string;
  part: string;
  amount: string;
  currency: string | null;
  state: string | null;
  provider: string | null;
  paymentId: string | null;
  refundId: string | null;
  transferKey: string | null;
  stripeTxId: string | null;
  coversId: number | null;
  orderId: number | null;
  userId: number | null;
  returnId: number | null;
  disputeId: number | null;
  orderShipmentId: number | null;
  // what root or a money admin decided the money was, and the shares of it (decide_money_use)
  moneyUse: string | null;
  meta: unknown;
  actorId: number | null;
  actorRole: string | null;
};

const LINE_COLUMNS = `id, event, purpose::text as purpose, part::text as part, amount::text as amount,
  currency, state::text as state, provider::text as provider, "paymentId", "refundId",
  "transferKey", "stripeTxId", "coversId", "orderId", "userId", "returnId", "disputeId",
  "orderShipmentId", "moneyUse"::text as "moneyUse", meta, "actorId", "actorRole"::text as "actorRole"`;

// the lines an admin reads that match the condition, oldest first
export async function linesWhere(
  db: DbSession,
  adminId: number,
  where: string,
  ...values: unknown[]
): Promise<Line[]> {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.rows<Line>(
    `select ${LINE_COLUMNS} from cartlify.money_log where ${where} order by id`,
    ...values,
  );
}

// one line by its id
export async function lineOf(db: DbSession, adminId: number, id: number): Promise<Line> {
  const [line] = await linesWhere(db, adminId, 'id = $1', id);
  return line!;
}

// ---------------------------------------------------------------------------------------------
// the refunds made by hand, the statements and their transfers
// ---------------------------------------------------------------------------------------------

const HAND = `select cartlify.record_hand_refund(
  'stripe'::cartlify."PaymentProvider", $1, $2, $3::numeric, $4, 'eur') as result`;

// a refund made by hand in the dashboard of the provider, as the webhook writes it from its event;
// the id of its line and of the refund at the provider
export async function handRefundOf(
  db: DbSession,
  paymentId: string,
  amount: number,
  status: 'succeeded' | 'pending' = 'succeeded',
): Promise<{ id: number; refundId: string }> {
  const refundId = `re_hand_${randomUUID()}`;
  const answer = await answerOf(db, SYSTEM, HAND, paymentId, refundId, amount, status);
  return { id: answer.id as number, refundId };
}

const SETTLE = `select cartlify.settle_money_refund(
  $1, $2, $3, $4::cartlify."RefundFailure", $5) as result`;

// the end of a refund as the provider tells it (by our key or by the id of the refund there)
export const settledOf = (
  db: DbSession,
  key: string | null,
  refundId: string | null,
  status: 'succeeded' | 'pending' | 'failed',
) =>
  answerOf(
    db,
    SYSTEM,
    SETTLE,
    key,
    refundId,
    status,
    status === 'failed' ? 'card_unavailable' : null,
    status === 'failed' ? 'the card is closed' : null,
  );

const CANCEL_ITEMS = `select cartlify.create_return(
  $1::int,
  (
    select jsonb_agg(jsonb_build_object('orderItemId', i.id, 'quantity', i.quantity) order by i.id)
    from cartlify.order_items as i
    where i."orderId" = $1::int and ($2::int[] is null or i.id = any($2::int[]))
  ),
  'admin'::cartlify."ReturnSource",
  'other'::cartlify."ReturnBasis",
  'shop_cancel'::cartlify."ReturnReason",
  null, 'Test Buyer', 'buyer@example.com', null, null, 4, 'Europe/Madrid'
) as id`;

// the shop cancels the items named of a paid order that was not sent (all of them when none is
// named): a statement whose goods are back on the shelf at once and whose rows wait for their
// money; the order is cancelled once all of it is back. The id of the statement
export async function shopCancelOf(
  db: DbSession,
  adminId: number,
  orderId: number,
  itemIds: number[] | null = null,
): Promise<number> {
  await db.as({ role: 'ADMIN', userId: adminId });
  const outcome = await db.attempt<{ id: number }>(CANCEL_ITEMS, orderId, itemIds);
  if (!outcome.ok) throw new Error(`create_return refused: ${outcome.message}`);
  return outcome.rows[0]!.id;
}

// the items of an order, in their order
export async function itemIdsOf(db: DbSession, adminId: number, orderId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  const rows = await db.rows<{ id: number }>(
    'select id from cartlify.order_items where "orderId" = $1 order by id',
    orderId,
  );
  return rows.map((r) => r.id);
}

// the sum a statement gave back and whether it is over, as an admin reads it
export async function statementOf(db: DbSession, adminId: number, returnId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  const [row] = await db.rows<{ refundedTotal: string; closed: boolean }>(
    `select "refundedTotal"::text as "refundedTotal", "closedAt" is not null as closed
     from cartlify.returns where id = $1`,
    returnId,
  );
  return row!;
}

// the money of the rows of a statement
export async function rowsOf(db: DbSession, adminId: number, returnId: number) {
  await db.as({ role: 'ADMIN', userId: adminId });
  return db.rows<{ id: number; money: string; moneyLogId: number | null }>(
    `select id, money::text as money, "moneyLogId"
     from cartlify.return_items where "returnId" = $1 order by id`,
    returnId,
  );
}

const BEGIN = `select cartlify.begin_return_refund($1::int, $2::int[], null::jsonb) as result`;

// an admin starts a transfer of the rows named of a statement (all it can refund when none is named)
export const beginOf = (
  db: DbSession,
  adminId: number,
  returnId: number,
  itemIds: number[] | null = null,
) => call<{ result: Answer }>(db, { role: 'ADMIN', userId: adminId }, BEGIN, returnId, itemIds);

// the same, and it has to work
export async function begun(
  db: DbSession,
  adminId: number,
  returnId: number,
  itemIds: number[] | null = null,
): Promise<Answer> {
  const outcome = await beginOf(db, adminId, returnId, itemIds);
  if (!outcome.ok) throw new Error(`begin_return_refund refused: ${outcome.message}`);
  return outcome.rows[0]!.result;
}

// ---------------------------------------------------------------------------------------------
// what root decides
// ---------------------------------------------------------------------------------------------

export const DECIDE = `select cartlify.decide_order_hold($1::int, $2, $3, $4) as result`;
export const DECIDE_USE = `select cartlify.decide_money_use($1::int, $2::jsonb, $3::numeric, $4) as result`;

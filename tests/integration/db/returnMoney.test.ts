import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';
import { readReturnCard } from '@routes/api/returns/services/helpers/returnCard.helper.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { paidOrderOf, stockOf, type DeliveryRule } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { publishContractIn, returnParcelIn, withdrawalStatementIn } from '../../helpers/returns.js';

// the money of the statements in the database: how a transfer back is started for rows of a
// statement (begin_return_refund), what each answer of the provider does to the rows
// (finish_return_refund), the money root sends outside the app (mark_return_refunded_outside), the
// rows root closes without a refund (close_return_without_refund), and the delivery that goes
// back with the last row. All in transactions that roll back

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let plain: TestProduct;

beforeAll(async () => {
  buyer = await createUser({ name: 'Anna Koval' });
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  plain = await createProduct({ price: 10, stock: 40 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asAdmin = (db: DbSession) => db.as({ role: 'ADMIN', userId: admin.id });
const asRoot = (db: DbSession) => db.as({ role: 'ROOT', userId: root.id });
// the server acting by itself: the payment webhook, the worker
const asSystem = (db: DbSession) => db.as({ role: 'ADMIN' });

const DELIVERY_FIVE: DeliveryRule = { flat: 5 };

type ItemRow = { id: number; quantity: number };

// a paid order of the units asked of the plain product (10 each), with the delivery rule given
async function soldOrder(db: DbSession, units: number, rule: DeliveryRule = {}) {
  const orderId = await paidOrderOf(db, buyer.id, admin.id, [[plain.variantId, units]], rule);
  await asAdmin(db);
  const items = await db.rows<ItemRow>(
    `select id, quantity from cartlify.order_items where "orderId" = $1 order by id`,
    orderId,
  );
  return { orderId, itemId: items[0]!.id };
}

// a statement of an admin for units of the item; its id
async function statementOf(db: DbSession, orderId: number, itemId: number, quantity: number) {
  await asAdmin(db);
  const outcome = await db.attempt<{ id: number }>(
    `select cartlify.create_return(
       $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
       'defect'::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null, null, 4,
       'Europe/Madrid'
     ) as id`,
    orderId,
    JSON.stringify([{ orderItemId: itemId, quantity }]),
  );
  if (!outcome.ok) throw new Error(`create_return refused: ${outcome.message}`);
  return outcome.rows[0]!.id;
}

type Result = {
  itemId: number;
  quantity: number;
  goods: 'to_stock' | 'written_off' | 'not_accepted' | 'lost' | 'not_arrived';
  notAcceptedReason?: string;
};

const receive = (db: DbSession, returnId: number, results: Result[]) =>
  db.attempt(
    `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb)`,
    returnId,
    JSON.stringify(results),
  );

type Row = {
  id: number;
  quantity: number;
  goods: string;
  money: string;
  amount: number;
  amountNote: string | null;
  deliveryShare: number;
  refundKey: string | null;
  refundId: string | null;
  refundedAt: string | null;
  refundFailure: string | null;
  refundFailureText: string | null;
  outsideMethod: string | null;
  outsideNote: string | null;
  outsideById: number | null;
  refusedCode: string | null;
  shippingDeduction: number;
};

const rowsOf = (db: DbSession, returnId: number) =>
  db.rows<Row>(
    `select id, quantity, goods::text as goods, money::text as money, amount::float8 as amount,
            "amountNote", "deliveryShare"::float8 as "deliveryShare", "refundKey"::text as "refundKey",
            "refundId", "refundedAt"::text as "refundedAt", "refundFailure"::text as "refundFailure",
            "refundFailureText", "outsideMethod"::text as "outsideMethod", "outsideNote",
            "outsideById", "refusedCode"::text as "refusedCode",
            "shippingDeduction"::float8 as "shippingDeduction"
     from cartlify.return_items where "returnId" = $1 order by id`,
    returnId,
  );

type Beginning = {
  key: string;
  returnId: number;
  orderId: number;
  provider: string;
  paymentId: string;
  amount: string;
  itemIds: number[];
};

const begin = (
  db: DbSession,
  returnId: number,
  itemIds: number[] | null = null,
  reductions: unknown = null,
) =>
  db.attempt<{ done: Beginning }>(
    `select cartlify.begin_return_refund($1::int, $2::int[], $3::jsonb) as done`,
    returnId,
    itemIds,
    reductions === null ? null : JSON.stringify(reductions),
  );

type Finished = {
  changed: boolean;
  status: string;
  returnId?: number;
  orderId?: number;
  itemIds?: number[];
  amount?: string;
};

const finish = (
  db: DbSession,
  key: string,
  status: string,
  opts: { refundId?: string; failure?: string | undefined; text?: string } = {},
) =>
  db.attempt<{ done: Finished }>(
    `select cartlify.finish_return_refund($1::uuid, $2::text, $3::text,
            $4::cartlify."ReturnRefundFailure", $5::text) as done`,
    key,
    status,
    opts.refundId ?? null,
    opts.failure ?? null,
    opts.text ?? null,
  );

const outside = (
  db: DbSession,
  returnId: number,
  opts: { ids?: number[] | null; method?: string | null; note?: string; at: string },
) =>
  db.attempt<{ done: { amount: string; itemIds: number[] } }>(
    `select cartlify.mark_return_refunded_outside(
       $1::int, $2::int[], $3::cartlify."ReturnOutsideMethod", $4::text, $5::timestamp
     ) as done`,
    returnId,
    opts.ids ?? null,
    opts.method === undefined ? 'bank_transfer' : opts.method,
    opts.note ?? 'Sent to the account of the buyer.',
    opts.at,
  );

const closeRows = (
  db: DbSession,
  returnId: number,
  opts: { ids?: number[] | null; code?: string | null; note?: string } = {},
) =>
  db.attempt<{ done: { closed: boolean; itemIds: number[] } }>(
    `select cartlify.close_return_without_refund(
       $1::int, $2::int[], $3::cartlify."ReturnCloseCode", $4::text
     ) as done`,
    returnId,
    opts.ids ?? null,
    opts.code === undefined ? 'goods_not_returned' : opts.code,
    opts.note ?? 'The goods never came.',
  );

const stateOf = async (db: DbSession, orderId: number, returnId: number) => {
  const [row] = await db.rows<{
    status: string;
    closedAt: string | null;
    closedById: number | null;
    closeCode: string | null;
    closeNote: string | null;
  }>(
    `select o."returnStatus"::text as status, r."closedAt"::text as "closedAt", r."closedById",
            r."closeCode"::text as "closeCode", r."closeNote"
     from cartlify.orders o, cartlify.returns r where o.id = $1 and r.id = $2`,
    orderId,
    returnId,
  );
  return row!;
};

const paidAtOf = async (db: DbSession, orderId: number) => {
  const [row] = await db.rows<{ at: string }>(
    `select "paidAt"::text as at from cartlify.orders where id = $1`,
    orderId,
  );
  return row!.at;
};

// a statement whose units are on the shelf, ready for their money
async function comeBack(db: DbSession, orderId: number, itemId: number, units: number) {
  const returnId = await statementOf(db, orderId, itemId, units);
  const [row] = await rowsOf(db, returnId);
  await receive(db, returnId, [{ itemId: row!.id, quantity: units, goods: 'to_stock' }]);
  return returnId;
}

describe('begin_return_refund', () => {
  it('puts the rows that came back on their way under one key, for the sum of their units', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 3, DELIVERY_FIVE);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const outcome = await begin(db, returnId);
      const [payment] = await db.rows<{ paymentId: string }>(
        `select "paymentId" from cartlify.orders where id = $1`,
        orderId,
      );
      return {
        outcome,
        payment: payment!.paymentId,
        rows: await rowsOf(db, returnId),
        state: await stateOf(db, orderId, returnId),
      };
    });

    if (!result.outcome.ok) throw new Error(result.outcome.message ?? 'refused');
    const started = result.outcome.rows[0]!.done;
    // 2 of the 3 units: no delivery goes back, the order is not whole
    expect(started).toMatchObject({
      amount: '20.00',
      provider: 'stripe',
      paymentId: result.payment,
      itemIds: [result.rows[0]!.id],
    });
    expect(result.rows).toEqual([
      expect.objectContaining({
        money: 'pending',
        refundKey: started.key,
        deliveryShare: 0,
        refundId: null,
        refundedAt: null,
      }),
    ]);
    // money on its way is not money back: the statement is open and the order says so
    expect(result.state).toMatchObject({ status: 'open', closedAt: null });
  });

  it('gives the delivery, all of it, with the last row of the call that makes the order whole', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const returnId = await comeBack(db, orderId, itemId, 2);
      return { outcome: await begin(db, returnId), rows: await rowsOf(db, returnId) };
    });

    expect(result.outcome.ok && result.outcome.rows[0]!.done.amount).toBe('25.00');
    expect(result.rows.map((row) => [row.amount, row.deliveryShare])).toEqual([[20, 5]]);
  });

  it('gives the delivery to the statement that completes the order, not to the first', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const first = await comeBack(db, orderId, itemId, 1);
      const second = await comeBack(db, orderId, itemId, 1);
      const a = await begin(db, first);
      const b = await begin(db, second);
      return {
        a: a.ok && a.rows[0]!.done.amount,
        b: b.ok && b.rows[0]!.done.amount,
        rows: [...(await rowsOf(db, first)), ...(await rowsOf(db, second))],
      };
    });

    expect(result.a).toBe('10.00');
    expect(result.b).toBe('15.00');
    expect(result.rows.map((row) => row.deliveryShare)).toEqual([0, 5]);
  });

  // a row whose transfer failed is still owed its money: it counts for the order to be whole, so
  // the delivery is never left without a row to go with
  it('gives the delivery to the transfer that completes the order when a row of it failed before', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const first = await comeBack(db, orderId, itemId, 1);
      const second = await comeBack(db, orderId, itemId, 1);
      const a = await begin(db, first);
      if (!a.ok) throw new Error(a.message ?? 'refused');
      await asAdmin(db);
      await finish(db, a.rows[0]!.done.key, 'failed', { failure: 'shop_balance' });
      const b = await begin(db, second);
      return {
        b: b.ok && b.rows[0]!.done.amount,
        rows: [...(await rowsOf(db, first)), ...(await rowsOf(db, second))],
      };
    });

    expect(result.b).toBe('15.00');
    expect(result.rows.map((row) => row.deliveryShare)).toEqual([0, 5]);
  });

  // the delivery goes back only with an order that comes back whole: a disputed transfer is never
  // sent again, so a row that has not sent its money gives the delivery up
  it('takes the delivery off a row that has not sent its money once the order cannot come back whole', async () => {
    const rows = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const first = await comeBack(db, orderId, itemId, 1);
      const second = await comeBack(db, orderId, itemId, 1);
      const fail = async (returnId: number, failure: string) => {
        const started = await begin(db, returnId);
        if (!started.ok) throw new Error(started.message ?? 'refused');
        await asAdmin(db);
        await finish(db, started.rows[0]!.done.key, 'failed', { failure });
      };
      await fail(first, 'shop_balance');
      await fail(second, 'card_unavailable');
      const held = (await rowsOf(db, second))[0]!.deliveryShare;
      await fail(first, 'disputed');
      return { held, after: (await rowsOf(db, second))[0]!.deliveryShare };
    });

    expect(rows).toEqual({ held: 5, after: 0 });
  });

  it('gives no delivery when a unit of the order was not accepted: the order never became whole', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const returnId = await statementOf(db, orderId, itemId, 2);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [
        { itemId: row!.id, quantity: 1, goods: 'to_stock' },
        { itemId: row!.id, quantity: 1, goods: 'not_accepted', notAcceptedReason: 'unsealed' },
      ]);
      return { outcome: await begin(db, returnId), rows: await rowsOf(db, returnId) };
    });

    expect(result.outcome.ok && result.outcome.rows[0]!.done.amount).toBe('10.00');
    expect(result.rows.every((row) => row.deliveryShare === 0)).toBe(true);
  });

  it('takes by default the rows that came back; a row that still waits for its goods needs the proof first', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await statementOf(db, orderId, itemId, 2);
      const [row] = await rowsOf(db, returnId);
      const nothing = await begin(db, returnId);
      const ahead = await begin(db, returnId, [row!.id]);
      await db.attempt(`select 1 as done from cartlify.confirm_return_proof($1::int)`, returnId);
      const proven = await begin(db, returnId);
      return { nothing, ahead, proven, rows: await rowsOf(db, returnId) };
    });

    expect(result.nothing).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEMS_REQUIRED'),
    });
    expect(result.ahead).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_PROOF_REQUIRED'),
    });
    expect(result.proven.ok && result.proven.rows[0]!.done.amount).toBe('20.00');
    expect(result.rows).toEqual([expect.objectContaining({ goods: 'expected', money: 'pending' })]);
  });

  it.each([
    [
      'goods that were not accepted',
      async (db: DbSession, returnId: number, rows: Row[]) => {
        await receive(db, returnId, [
          {
            itemId: rows[0]!.id,
            quantity: 1,
            goods: 'not_accepted',
            notAcceptedReason: 'unsealed',
          },
        ]);
        return [rows[0]!.id];
      },
      'RETURN_ITEM_NOT_REFUNDABLE',
    ],
    [
      'goods that did not arrive',
      async (db: DbSession, returnId: number, rows: Row[]) => {
        await receive(db, returnId, [{ itemId: rows[0]!.id, quantity: 1, goods: 'not_arrived' }]);
        return [rows[0]!.id];
      },
      'RETURN_ITEM_NOT_REFUNDABLE',
    ],
    [
      'a row already on its way: a double click starts nothing twice',
      async (db: DbSession, returnId: number, rows: Row[]) => {
        await receive(db, returnId, [{ itemId: rows[0]!.id, quantity: 1, goods: 'to_stock' }]);
        await begin(db, returnId);
        return [rows[0]!.id];
      },
      'RETURN_ITEM_NOT_REFUNDABLE',
    ],
    [
      'a row that is not in the statement',
      async (_db: DbSession, _returnId: number, rows: Row[]) => [rows[0]!.id + 1_000_000],
      'RETURN_ITEM_NOT_FOUND',
    ],
    ['no rows named', async () => [] as number[], 'RETURN_ITEMS_REQUIRED'],
  ])('refuses %s (%s)', async (_what, prepare, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      const ids = await prepare(db, returnId, await rowsOf(db, returnId));
      return begin(db, returnId, ids);
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it('is for an admin or root: a buyer is refused (RETURN_FORBIDDEN), a statement that is not there is not found', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      await db.as({ role: 'USER', userId: buyer.id });
      const byBuyer = await begin(db, returnId);
      await asAdmin(db);
      return { byBuyer, missing: await begin(db, 2_147_483_000), rows: await rowsOf(db, returnId) };
    });

    expect(outcomes.byBuyer).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
    expect(outcomes.missing).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_NOT_FOUND'),
    });
    // nothing started
    expect(outcomes.rows[0]!.money).toBe('not_refunded');
  });

  it('lets root lower what a row refunds, with the reason, and an admin not at all', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const [row] = await rowsOf(db, returnId);
      const reduction = [{ itemId: row!.id, amount: 15, note: 'Opened and used.' }];
      await asAdmin(db);
      const byAdmin = await begin(db, returnId, null, reduction);
      await asRoot(db);
      const byRoot = await begin(db, returnId, null, reduction);
      return { byAdmin, byRoot, rows: await rowsOf(db, returnId) };
    });

    expect(result.byAdmin).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
    expect(result.byRoot.ok && result.byRoot.rows[0]!.done.amount).toBe('15.00');
    expect(result.rows).toEqual([
      expect.objectContaining({ amount: 15, amountNote: 'Opened and used.', money: 'pending' }),
    ]);
  });

  it.each([
    [
      'more than the units cost',
      (id: number) => [{ itemId: id, amount: 20.01, note: 'x' }],
      'RETURN_AMOUNT_INVALID',
    ],
    [
      'an amount that is not a number',
      (id: number) => [{ itemId: id, amount: 'ten', note: 'x' }],
      'RETURN_AMOUNT_INVALID',
    ],
    [
      'less without the reason',
      (id: number) => [{ itemId: id, amount: 5 }],
      'RETURN_AMOUNT_NOTE_REQUIRED',
    ],
    [
      'a row that is not in the call',
      (id: number) => [{ itemId: id + 1_000_000, amount: 5, note: 'x' }],
      'RETURN_ITEM_NOT_FOUND',
    ],
    [
      'a row of nothing, which could never be settled',
      (id: number) => [{ itemId: id, amount: 0, note: 'Used up.' }],
      'RETURN_AMOUNT_INVALID',
    ],
    [
      'the same row twice',
      (id: number) => [
        { itemId: id, amount: 5, note: 'x' },
        { itemId: id, amount: 6, note: 'x' },
      ],
      'RETURN_ITEMS_REPEATED',
    ],
    ['a list that is not a list', () => ({ amount: 5 }), 'RETURN_AMOUNT_INVALID'],
  ])('refuses root lowering %s (%s) and starts nothing', async (_what, reduction, code) => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const [row] = await rowsOf(db, returnId);
      await asRoot(db);
      return {
        outcome: await begin(db, returnId, null, reduction(row!.id)),
        rows: await rowsOf(db, returnId),
      };
    });

    expect(result.outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
    expect(result.rows).toEqual([
      expect.objectContaining({
        money: 'not_refunded',
        refundKey: null,
        amount: 20,
        amountNote: null,
      }),
    ]);
  });
});

// the way back: the contract says who pays it. When the buyer does and the shop paid the carrier, a
// transfer of a withdrawal takes it off (at most what the parcels cost); when the shop does and the
// buyer paid the carrier, root records the money paid back outside the app
describe('the cost of the way back', () => {
  const beginWith = (db: DbSession, returnId: number, deduction: number) =>
    db.attempt<{ done: Beginning & { deduction: string } }>(
      `select cartlify.begin_return_refund($1::int, null::int[], null::jsonb, $2::numeric) as done`,
      returnId,
      deduction,
    );

  // a withdrawal from a paid order of two units at 10 whose units came back, with a parcel back the
  // shop paid; the contract says who pays the way back
  async function withdrawal(db: DbSession, payer: 'buyer' | 'shop', cost = 7) {
    await publishContractIn(db, root.id, payer);
    const { orderId, itemId } = await soldOrder(db, 2);
    const returnId = await withdrawalStatementIn(db, admin.id, orderId, itemId, 2);
    const [row] = await rowsOf(db, returnId);
    await receive(db, returnId, [{ itemId: row!.id, quantity: 2, goods: 'to_stock' }]);
    await returnParcelIn(db, admin.id, returnId, cost);
    await asAdmin(db);
    return { orderId, returnId };
  }

  it('takes what the buyer owes off the transfer when the contract says the buyer pays the way back', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'buyer');
      const started = await beginWith(db, returnId, 5);
      return { started, rows: await rowsOf(db, returnId) };
    });

    expect(result.started).toMatchObject({
      ok: true,
      rows: [{ done: expect.objectContaining({ amount: '15.00', deduction: '5.00' }) }],
    });
    expect(result.rows).toEqual([
      expect.objectContaining({ money: 'pending', amount: 20, shippingDeduction: 5 }),
    ]);
  });

  it('takes no more than the parcels of the statement cost (RETURN_DEDUCTION_EXCEEDS_COST)', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await withdrawal(db, 'buyer', 7);
      const above = await beginWith(db, returnId, 7.01);
      return { above, orderId };
    });

    expect(outcomes.above).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_DEDUCTION_EXCEEDS_COST'),
    });
  });

  // an order that kept no contract (none was published when it was confirmed) is refused the same
  // way: the buyer was told nothing, so the shop pays (the shared database of the tests may hold a
  // contract of another file, so that order cannot be made here)
  it('takes nothing when the contract says the shop pays (RETURN_DEDUCTION_NOT_ALLOWED)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'shop');
      return beginWith(db, returnId, 5);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_DEDUCTION_NOT_ALLOWED'),
    });
  });

  it('takes nothing off a statement outside the withdrawal (RETURN_DEDUCTION_NOT_ALLOWED)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await publishContractIn(db, root.id, 'buyer');
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      await returnParcelIn(db, admin.id, returnId, 7);
      await asAdmin(db);
      return beginWith(db, returnId, 5);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_DEDUCTION_NOT_ALLOWED'),
    });
  });

  it('never leaves a transfer of nothing (RETURN_DEDUCTION_INVALID)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'buyer', 30);
      return beginWith(db, returnId, 20);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_DEDUCTION_INVALID'),
    });
  });

  // the card tells the admin the most the next transfer may still take off (a hint, the admin
  // decides) and warns of a parcel the shop paid, before the way back is paid to the buyer too
  it('shows on the card the most the next transfer may take off, less what a transfer took, and warns of the parcel', async () => {
    const result = await inRolledBackTx(async (db) => {
      const cardOf = async (returnId: number) => {
        await asAdmin(db);
        const card = await readReturnCard(db.tx, returnId, 'ADMIN');
        return { deductible: card!.deductible, warnings: card!.warnings };
      };
      await publishContractIn(db, root.id, 'buyer');
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await withdrawalStatementIn(db, admin.id, orderId, itemId, 2);
      const before = await cardOf(returnId);

      // the units come back in two steps, so the statement has two rows to pay apart
      const [whole] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: whole!.id, quantity: 1, goods: 'to_stock' }]);
      const waiting = (await rowsOf(db, returnId)).find((row) => row.goods === 'expected');
      await receive(db, returnId, [{ itemId: waiting!.id, quantity: 1, goods: 'to_stock' }]);
      await returnParcelIn(db, admin.id, returnId, 7);
      const withParcel = await cardOf(returnId);

      const [first] = await rowsOf(db, returnId);
      await asAdmin(db);
      const started = await db.attempt(
        `select cartlify.begin_return_refund($1::int, $2::int[], null::jsonb, 5::numeric) as done`,
        returnId,
        [first!.id],
      );
      const afterFive = await cardOf(returnId);
      return { before, withParcel, started, afterFive };
    });

    expect(result.before).toEqual({ deductible: 0, warnings: [] });
    expect(result.withParcel).toEqual({ deductible: 7, warnings: ['shop_paid_parcel'] });
    expect(result.started).toMatchObject({ ok: true });
    expect(result.afterFive).toEqual({ deductible: 2, warnings: ['shop_paid_parcel'] });
  });

  it('shows nothing to take off when the contract says the shop pays, and still warns of the parcel', async () => {
    const card = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'shop');
      await asAdmin(db);
      return readReturnCard(db.tx, returnId, 'ADMIN');
    });

    expect(card).toMatchObject({ deductible: 0, warnings: ['shop_paid_parcel'] });
  });

  const reimburse = (db: DbSession, returnId: number, at = "now() at time zone 'UTC'") =>
    db.attempt<{ done: { returnId: number; amount: string } }>(
      `select cartlify.record_return_reimbursement(
         $1::int, 6.5, 'bank_transfer'::cartlify."ReturnOutsideMethod", 'The receipt came by mail.',
         (${at})::timestamp(3)
       ) as done`,
      returnId,
    );

  it('records the way back root paid back to the buyer when the shop pays it, once', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'shop');
      await asRoot(db);
      const first = await reimburse(db, returnId);
      const again = await reimburse(db, returnId);
      await asRoot(db);
      const [row] = await db.rows<Record<string, unknown>>(
        `select "shippingReimbursed"::float8 as amount, "shippingReimbursedMethod"::text as method,
                "shippingReimbursedNote" as note, "shippingReimbursedById" as "byId"
         from cartlify.returns where id = $1`,
        returnId,
      );
      return { first, again, row };
    });

    expect(result.first).toMatchObject({ ok: true, rows: [{ done: { amount: '6.50' } }] });
    expect(result.again).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_REIMBURSEMENT_EXISTS'),
    });
    expect(result.row).toEqual({
      amount: 6.5,
      method: 'bank_transfer',
      note: 'The receipt came by mail.',
      byId: root.id,
    });
  });

  it('pays nothing back when the contract says the buyer pays the way back of the withdrawal', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'buyer');
      await asRoot(db);
      return reimburse(db, returnId);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_REIMBURSEMENT_NOT_ALLOWED'),
    });
  });

  it('is root only, and never of the future', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'shop');
      await asAdmin(db);
      const byAdmin = await reimburse(db, returnId);
      await asRoot(db);
      const future = await reimburse(db, returnId, "now() at time zone 'UTC' + interval '1 day'");
      return { byAdmin, future };
    });

    expect(outcomes.byAdmin).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
    expect(outcomes.future).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_OUTSIDE_AT_INVALID'),
    });
  });

  it('refuses a sum of nothing, below nothing or of more than two decimals', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'shop');
      await asRoot(db);
      const sums: Record<string, unknown> = {};
      for (const amount of ['0', '-1', '6.555']) {
        sums[amount] = await db.attempt(
          `select cartlify.record_return_reimbursement(
             $1::int, $2::numeric, 'bank_transfer'::cartlify."ReturnOutsideMethod", 'The receipt.',
             (now() at time zone 'UTC')::timestamp(3)
           ) as done`,
          returnId,
          amount,
        );
      }
      return sums;
    });

    for (const outcome of Object.values(outcomes)) {
      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_REIMBURSEMENT_INVALID'),
      });
    }
  });
});

describe('finish_return_refund', () => {
  it('refunds the rows when the provider says so: the order is full once the units and the delivery are back', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const started = await begin(db, returnId);
      if (!started.ok) throw new Error(started.message ?? 'refused');
      await asAdmin(db);
      const done = await finish(db, started.rows[0]!.done.key, 'succeeded', { refundId: 're_1' });
      return {
        done,
        rows: await rowsOf(db, returnId),
        state: await stateOf(db, orderId, returnId),
      };
    });

    expect(result.done.ok && result.done.rows[0]!.done).toMatchObject({
      changed: true,
      status: 'succeeded',
      amount: '25.00',
    });
    expect(result.rows).toEqual([
      expect.objectContaining({
        money: 'refunded',
        refundId: 're_1',
        refundedAt: expect.any(String),
        deliveryShare: 5,
      }),
    ]);
    expect(result.state).toMatchObject({
      status: 'full',
      closedAt: expect.any(String),
      closedById: admin.id,
    });
  });

  // the bank of a card that is gone sends the money of a refund back: the provider fails the refund
  // it had made, the rows wait for their money again and the statement is open
  it('takes back the rows of a refund the provider failed after it succeeded, once', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const started = await begin(db, returnId);
      if (!started.ok) throw new Error(started.message ?? 'refused');
      await asAdmin(db);
      const key = started.rows[0]!.done.key;
      await finish(db, key, 'succeeded', { refundId: 're_1' });
      const closed = await stateOf(db, orderId, returnId);
      const other = await finish(db, key, 'failed', {
        refundId: 're_other',
        failure: 'card_unavailable',
        text: 'expired_or_canceled_card',
      });
      const back = await finish(db, key, 'failed', {
        refundId: 're_1',
        failure: 'card_unavailable',
        text: 'expired_or_canceled_card',
      });
      const again = await finish(db, key, 'failed', {
        refundId: 're_1',
        failure: 'card_unavailable',
        text: 'expired_or_canceled_card',
      });
      return {
        closed,
        other,
        back,
        again,
        rows: await rowsOf(db, returnId),
        state: await stateOf(db, orderId, returnId),
      };
    });

    expect(result.closed).toMatchObject({ status: 'full', closedAt: expect.any(String) });
    expect(result.other.ok && result.other.rows[0]!.done).toMatchObject({ changed: false });
    expect(result.back.ok && result.back.rows[0]!.done).toMatchObject({
      changed: true,
      status: 'failed',
      amount: '25.00',
      reversed: true,
    });
    expect(result.again.ok && result.again.rows[0]!.done).toMatchObject({ changed: false });
    expect(result.rows).toEqual([
      expect.objectContaining({
        money: 'not_refunded',
        refundKey: null,
        refundId: null,
        refundedAt: null,
        refundFailure: 'card_unavailable',
        refundFailureText: 'expired_or_canceled_card',
      }),
    ]);
    expect(result.state).toMatchObject({ status: 'open', closedAt: null, closedById: null });
  });

  it('says partial when only some of the units went back, and the system may settle it too', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const returnId = await comeBack(db, orderId, itemId, 1);
      const started = await begin(db, returnId);
      if (!started.ok) throw new Error(started.message ?? 'refused');
      await asSystem(db);
      await finish(db, started.rows[0]!.done.key, 'succeeded', { refundId: 're_2' });
      return { state: await stateOf(db, orderId, returnId) };
    });

    // the statement is over, the order is not whole: the delivery stayed
    expect(result.state).toMatchObject({
      status: 'partial',
      closedAt: expect.any(String),
      closedById: null,
    });
  });

  it('keeps the rows on their way while the provider is still deciding, and keeps its id', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      const started = await begin(db, returnId);
      if (!started.ok) throw new Error(started.message ?? 'refused');
      const key = started.rows[0]!.done.key;
      await asAdmin(db);
      const pending = await finish(db, key, 'pending', { refundId: 're_3' });
      const afterPending = await rowsOf(db, returnId);
      const settled = await finish(db, key, 'succeeded');
      return { pending, afterPending, settled, rows: await rowsOf(db, returnId) };
    });

    expect(result.pending.ok && result.pending.rows[0]!.done.changed).toBe(false);
    expect(result.afterPending).toEqual([
      expect.objectContaining({ money: 'pending', refundId: 're_3' }),
    ]);
    // the id the provider gave stays when the end comes without one
    expect(result.rows).toEqual([expect.objectContaining({ money: 'refunded', refundId: 're_3' })]);
  });

  it('takes the key off a failed transfer and keeps why, so a new try has a new key', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      const started = await begin(db, returnId);
      if (!started.ok) throw new Error(started.message ?? 'refused');
      await asAdmin(db);
      await finish(db, started.rows[0]!.done.key, 'failed', {
        failure: 'card_unavailable',
        text: 'The card is closed.',
      });
      const failed = await rowsOf(db, returnId);
      const state = await stateOf(db, orderId, returnId);
      const again = await begin(db, returnId);
      return {
        first: started.rows[0]!.done.key,
        failed,
        state,
        again,
        rows: await rowsOf(db, returnId),
      };
    });

    expect(result.failed).toEqual([
      expect.objectContaining({
        money: 'not_refunded',
        refundKey: null,
        refundId: null,
        refundFailure: 'card_unavailable',
        refundFailureText: 'The card is closed.',
      }),
    ]);
    expect(result.state).toMatchObject({ status: 'open', closedAt: null });
    expect(result.again.ok && result.again.rows[0]!.done.key).not.toBe(result.first);
    expect(result.rows).toEqual([
      expect.objectContaining({ money: 'pending', refundFailure: null, refundFailureText: null }),
    ]);
  });

  it('changes nothing the second time, for a key nobody knows, and after the end', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      const started = await begin(db, returnId);
      if (!started.ok) throw new Error(started.message ?? 'refused');
      const key = started.rows[0]!.done.key;
      await asAdmin(db);
      await finish(db, key, 'succeeded', { refundId: 're_4' });
      return {
        again: await finish(db, key, 'succeeded', { refundId: 're_4' }),
        failedAfter: await finish(db, key, 'failed', { failure: 'unknown' }),
        stranger: await finish(db, '11111111-1111-4111-8111-111111111111', 'succeeded'),
        rows: await rowsOf(db, returnId),
      };
    });

    for (const outcome of [result.again, result.failedAfter, result.stranger]) {
      expect(outcome.ok && outcome.rows[0]!.done.changed).toBe(false);
    }
    expect(result.rows).toEqual([expect.objectContaining({ money: 'refunded', refundId: 're_4' })]);
  });

  it.each([
    ['a status that is none of the three', 'later', undefined, 'RETURN_REFUND_STATUS_INVALID'],
    ['a failure without its reason', 'failed', undefined, 'RETURN_REFUND_STATUS_INVALID'],
  ])('refuses %s (%s)', async (_what, status, failure, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      await asAdmin(db);
      return finish(db, '11111111-1111-4111-8111-111111111111', status, { failure });
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it.each([
    ['a buyer', (): Actor => ({ role: 'USER', userId: buyer.id })],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: '11111111-1111-4111-8111-111111111111' })],
  ])('refuses %s (RETURN_FORBIDDEN)', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(actor());
      return finish(db, '11111111-1111-4111-8111-111111111111', 'succeeded');
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
  });
});

describe('mark_return_refunded_outside', () => {
  // a transfer that failed with the reason, the order and the statement of it
  async function failedTransfer(db: DbSession, failure: string, delivery = false) {
    const { orderId, itemId } = await soldOrder(db, 2, delivery ? DELIVERY_FIVE : {});
    const returnId = await comeBack(db, orderId, itemId, 2);
    const started = await begin(db, returnId);
    if (!started.ok) throw new Error(started.message ?? 'refused');
    await asAdmin(db);
    await finish(db, started.rows[0]!.done.key, 'failed', { failure });
    return { orderId, returnId };
  }

  it('records money sent outside the app on the day it really went, with the sum of the rows and the delivery', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await failedTransfer(db, 'card_unavailable', true);
      const at = await paidAtOf(db, orderId);
      await asRoot(db);
      return {
        at,
        done: await outside(db, returnId, { at }),
        rows: await rowsOf(db, returnId),
        state: await stateOf(db, orderId, returnId),
      };
    });

    expect(result.done.ok && result.done.rows[0]!.done.amount).toBe('25.00');
    expect(result.rows).toEqual([
      expect.objectContaining({
        money: 'refunded',
        refundedAt: result.at,
        refundKey: null,
        outsideMethod: 'bank_transfer',
        outsideNote: 'Sent to the account of the buyer.',
        outsideById: root.id,
        refundFailure: null,
        refundFailureText: null,
      }),
    ]);
    expect(result.state).toMatchObject({ status: 'full', closedById: root.id });
  });

  it.each([
    ['an admin', 'RETURN_FORBIDDEN'],
    ['a buyer', 'RETURN_FORBIDDEN'],
  ])('is refused to %s (%s)', async (who, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await failedTransfer(db, 'unknown');
      const at = await paidAtOf(db, orderId);
      if (who === 'an admin') await asAdmin(db);
      else await db.as({ role: 'USER', userId: buyer.id });
      return outside(db, returnId, { at });
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it('never records a transfer the buyer disputed at the bank: the bank settles it', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await failedTransfer(db, 'disputed');
      const at = await paidAtOf(db, orderId);
      const [row] = await rowsOf(db, returnId);
      await asRoot(db);
      return {
        named: await outside(db, returnId, { at, ids: [row!.id] }),
        byDefault: await outside(db, returnId, { at }),
      };
    });

    expect(outcomes.named).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_REFUND_DISPUTED'),
    });
    // by default the disputed rows are not taken: nothing is left to record
    expect(outcomes.byDefault).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEMS_REQUIRED'),
    });
  });

  it('never sends again a transfer the buyer disputed at the bank, and keeps its reason', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { returnId } = await failedTransfer(db, 'disputed');
      const [row] = await rowsOf(db, returnId);
      await asAdmin(db);
      const named = await begin(db, returnId, [row!.id]);
      const byDefault = await begin(db, returnId);
      await asAdmin(db);
      return { named, byDefault, rows: await rowsOf(db, returnId) };
    });

    expect(outcomes.named).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_REFUND_DISPUTED'),
    });
    expect(outcomes.byDefault).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEMS_REQUIRED'),
    });
    expect(outcomes.rows).toEqual([
      expect.objectContaining({ money: 'not_refunded', refundFailure: 'disputed' }),
    ]);
  });

  it('is for a row whose transfer failed, not for one that was never tried (RETURN_ITEM_NOT_FAILED)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      const at = await paidAtOf(db, orderId);
      const [row] = await rowsOf(db, returnId);
      await asRoot(db);
      return outside(db, returnId, { at, ids: [row!.id] });
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEM_NOT_FAILED'),
    });
  });

  it.each([
    [
      'a day in the future',
      async () => '2999-01-01 00:00:00',
      undefined,
      'RETURN_OUTSIDE_AT_INVALID',
    ],
    [
      'a day before the order was paid',
      async () => '2026-01-02 10:00:00',
      undefined,
      'RETURN_OUTSIDE_AT_INVALID',
    ],
    ['no note', null, { note: '   ' }, 'RETURN_OUTSIDE_NOTE_REQUIRED'],
    ['no method', null, { method: null }, 'RETURN_OUTSIDE_NOTE_REQUIRED'],
  ])('refuses %s (%s) and records nothing', async (_what, day, extra, code) => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await failedTransfer(db, 'unknown');
      const at = day ? await day() : await paidAtOf(db, orderId);
      await asRoot(db);
      return {
        outcome: await outside(db, returnId, { at, ...extra }),
        rows: await rowsOf(db, returnId),
      };
    });

    expect(result.outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
    expect(result.rows).toEqual([
      expect.objectContaining({ money: 'not_refunded', outsideMethod: null }),
    ]);
  });
});

describe('close_return_without_refund', () => {
  it('closes the rows that wait for goods that never came, with the code and the note, and leaves the stock', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await statementOf(db, orderId, itemId, 2);
      const before = await stockOf(db, admin.id, plain.variantId);
      await asRoot(db);
      const outcome = await closeRows(db, returnId, {
        code: 'buyer_changed_mind',
        note: 'Wrote us they keep it.',
      });
      return {
        outcome,
        rows: await rowsOf(db, returnId),
        state: await stateOf(db, orderId, returnId),
        before,
        after: await stockOf(db, admin.id, plain.variantId),
      };
    });

    expect(result.outcome.ok && result.outcome.rows[0]!.done.closed).toBe(true);
    expect(result.rows).toEqual([
      expect.objectContaining({
        goods: 'not_arrived',
        money: 'refused',
        refusedCode: 'buyer_changed_mind',
        deliveryShare: 0,
      }),
    ]);
    expect(result.state).toMatchObject({
      status: 'declined',
      closeCode: 'buyer_changed_mind',
      closeNote: 'Wrote us they keep it.',
      closedById: root.id,
    });
    expect(result.after).toEqual(result.before);
  });

  it('closes only the rows that wait: units that came back still need their money, so the statement stays open', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await statementOf(db, orderId, itemId, 2);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
      await asRoot(db);
      return { outcome: await closeRows(db, returnId), rows: await rowsOf(db, returnId) };
    });

    expect(result.outcome.ok && result.outcome.rows[0]!.done.closed).toBe(false);
    expect(result.rows.map((row) => [row.goods, row.money])).toEqual([
      ['not_arrived', 'refused'],
      ['to_stock', 'not_refunded'],
    ]);
  });

  it.each([
    ['an admin', 'RETURN_FORBIDDEN'],
    ['a buyer', 'RETURN_FORBIDDEN'],
  ])('is refused to %s (%s)', async (who, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      if (who === 'an admin') await asAdmin(db);
      else await db.as({ role: 'USER', userId: buyer.id });
      return closeRows(db, returnId);
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it.each([
    ['no code', { code: null }, 'RETURN_CLOSE_NOTE_REQUIRED'],
    ['an empty note', { note: ' ' }, 'RETURN_CLOSE_NOTE_REQUIRED'],
  ])('refuses %s (%s)', async (_what, extra, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      await asRoot(db);
      return closeRows(db, returnId, extra);
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it('refuses a row whose goods came back or whose money is on its way (RETURN_ITEM_NOT_CLOSABLE)', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await statementOf(db, orderId, itemId, 2);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
      const rows = await rowsOf(db, returnId);
      const waiting = rows.find((one) => one.goods === 'expected')!;
      const back = rows.find((one) => one.goods === 'to_stock')!;
      await asAdmin(db);
      await db.attempt(`select 1 as done from cartlify.confirm_return_proof($1::int)`, returnId);
      await begin(db, returnId, [waiting.id]);
      await asRoot(db);
      return {
        back: await closeRows(db, returnId, { ids: [back.id] }),
        onItsWay: await closeRows(db, returnId, { ids: [waiting.id] }),
        none: await closeRows(db, returnId),
      };
    });

    expect(outcomes.back).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEM_NOT_CLOSABLE'),
    });
    expect(outcomes.onItsWay).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEM_NOT_CLOSABLE'),
    });
    expect(outcomes.none).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEMS_REQUIRED'),
    });
  });

  it('gives the units back: they can be stated again, whatever the code was', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      await asRoot(db);
      await closeRows(db, returnId, { code: 'not_buyer' });
      await asAdmin(db);
      return db.attempt(
        `select cartlify.create_return(
           $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
           'defect'::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null, null, 4,
           'Europe/Madrid'
         ) as id`,
        orderId,
        JSON.stringify([{ orderItemId: itemId, quantity: 1 }]),
      );
    });

    expect(outcome.ok).toBe(true);
  });
});

describe('the goods of a row whose money is already settled or has failed', () => {
  it('lets goods that wait come back after the money was paid ahead: both rows keep the transfer', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await statementOf(db, orderId, itemId, 2);
      await asAdmin(db);
      await db.attempt(`select 1 as done from cartlify.confirm_return_proof($1::int)`, returnId);
      const started = await begin(db, returnId);
      if (!started.ok) throw new Error(started.message ?? 'refused');
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
      const split = await rowsOf(db, returnId);
      const done = await finish(db, started.rows[0]!.done.key, 'succeeded', { refundId: 're_9' });
      return { key: started.rows[0]!.done.key, split, done, rows: await rowsOf(db, returnId) };
    });

    // 20 split by the units: 10 and 10, one key
    expect(result.split.map((row) => [row.quantity, row.amount, row.money, row.refundKey])).toEqual(
      [
        [1, 10, 'pending', result.key],
        [1, 10, 'pending', result.key],
      ],
    );
    expect(result.done.ok && result.done.rows[0]!.done.itemIds).toHaveLength(2);
    expect(result.rows.every((row) => row.money === 'refunded' && row.refundId === 're_9')).toBe(
      true,
    );
  });

  it('refuses to not accept goods whose money is on its way or back (RETURN_ITEM_MONEY_SETTLED)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      await asAdmin(db);
      await db.attempt(`select 1 as done from cartlify.confirm_return_proof($1::int)`, returnId);
      await begin(db, returnId);
      const [row] = await rowsOf(db, returnId);
      return receive(db, returnId, [
        { itemId: row!.id, quantity: 1, goods: 'not_accepted', notAcceptedReason: 'used' },
      ]);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEM_MONEY_SETTLED'),
    });
  });

  it('clears the failure and the delivery of a row whose goods then never arrive', async () => {
    const rows = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1, DELIVERY_FIVE);
      const returnId = await statementOf(db, orderId, itemId, 1);
      await asAdmin(db);
      await db.attempt(`select 1 as done from cartlify.confirm_return_proof($1::int)`, returnId);
      const started = await begin(db, returnId);
      if (!started.ok) throw new Error(started.message ?? 'refused');
      await finish(db, started.rows[0]!.done.key, 'failed', {
        failure: 'unknown',
        text: 'Try later.',
      });
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'not_arrived' }]);
      return rowsOf(db, returnId);
    });

    expect(rows).toEqual([
      expect.objectContaining({
        money: 'refused',
        deliveryShare: 0,
        refundFailure: null,
        refundFailureText: null,
      }),
    ]);
  });

  // the money went back ahead of the goods and the parcel never came: the goods are not arrived,
  // the money stays refunded (the shop gets it back outside the app), the stock does not move, and
  // the statement is over
  it('records goods paid ahead that never arrive: the money stays refunded, the stock stays', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      await asAdmin(db);
      await db.attempt(`select 1 as done from cartlify.confirm_return_proof($1::int)`, returnId);
      const started = await begin(db, returnId);
      if (!started.ok) throw new Error(started.message ?? 'refused');
      await finish(db, started.rows[0]!.done.key, 'succeeded', { refundId: 're_ahead' });
      const before = await stockOf(db, admin.id, plain.variantId);
      const [row] = await rowsOf(db, returnId);
      await asAdmin(db);
      const outcome = await receive(db, returnId, [
        { itemId: row!.id, quantity: 1, goods: 'not_arrived' },
      ]);
      await asAdmin(db);
      const [statement] = await db.rows<{ closed: boolean }>(
        `select "closedAt" is not null as closed from cartlify.returns where id = $1`,
        returnId,
      );
      return {
        outcome,
        rows: await rowsOf(db, returnId),
        before,
        after: await stockOf(db, admin.id, plain.variantId),
        statement,
      };
    });

    expect(result.outcome.ok).toBe(true);
    expect(result.rows).toEqual([
      expect.objectContaining({ goods: 'not_arrived', money: 'refunded', refundId: 're_ahead' }),
    ]);
    expect(result.after).toEqual(result.before);
    expect(result.statement).toEqual({ closed: true });
  });

  it('still refuses goods that never arrive while their money is on its way (RETURN_ITEM_MONEY_SETTLED)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      await asAdmin(db);
      await db.attempt(`select 1 as done from cartlify.confirm_return_proof($1::int)`, returnId);
      await begin(db, returnId);
      const [row] = await rowsOf(db, returnId);
      return receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'not_arrived' }]);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEM_MONEY_SETTLED'),
    });
  });
});

// the end of a dispute of the payment at the bank for the rows whose transfer failed as disputed:
// lost (the rows are refunded by chargeback on the day given) or won (the mark goes, the money is
// sent again the usual way); root or the system (a later webhook of the provider)
describe('settle_return_dispute', () => {
  const settle = (db: DbSession, orderId: number, won: boolean, note: string | null, at: string) =>
    db.attempt<{ done: { orderId: number; itemIds: number[]; won: boolean; amount: string } }>(
      `select cartlify.settle_return_dispute($1::int, $2::boolean, $3::text, (${at})::timestamp(3)) as done`,
      orderId,
      won,
      note,
    );

  // a statement whose units came back and whose transfer failed as disputed at the bank
  async function disputed(db: DbSession) {
    const { orderId, itemId } = await soldOrder(db, 1);
    const returnId = await comeBack(db, orderId, itemId, 1);
    const started = await begin(db, returnId);
    if (!started.ok) throw new Error(started.message ?? 'refused');
    await finish(db, started.rows[0]!.done.key, 'failed', {
      failure: 'disputed',
      text: 'Dispute.',
    });
    return { orderId, returnId };
  }

  const NOW = "now() at time zone 'UTC'";

  it('refunds the rows by chargeback on the day given when the dispute is lost, in the name of root', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await disputed(db);
      await asRoot(db);
      const done = await settle(db, orderId, false, 'The bank gave the buyer the money.', NOW);
      return { done, rows: await rowsOf(db, returnId) };
    });

    expect(result.done).toMatchObject({
      ok: true,
      rows: [{ done: { orderId: expect.any(Number), won: false, amount: '10.00' } }],
    });
    expect(result.rows).toEqual([
      expect.objectContaining({
        money: 'refunded',
        refundFailure: null,
        outsideMethod: 'chargeback',
        outsideNote: 'The bank gave the buyer the money.',
        outsideById: root.id,
      }),
    ]);
  });

  it('takes the mark off when the dispute is won, so the money can be sent again', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await disputed(db);
      await asRoot(db);
      const done = await settle(db, orderId, true, 'The bank kept the money with the shop.', NOW);
      await asAdmin(db);
      const again = await begin(db, returnId);
      return { done, again };
    });

    expect(result.done).toMatchObject({ ok: true, rows: [{ done: { won: true } }] });
    expect(result.again.ok).toBe(true);
  });

  it('lets the system settle it, with no one named', async () => {
    const rows = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await disputed(db);
      await asSystem(db);
      const done = await settle(db, orderId, false, 'charge.dispute.closed: lost', NOW);
      if (!done.ok) throw new Error(done.message ?? 'refused');
      return rowsOf(db, returnId);
    });

    expect(rows).toEqual([
      expect.objectContaining({
        money: 'refunded',
        outsideMethod: 'chargeback',
        outsideById: null,
      }),
    ]);
  });

  it('is refused to an admin, for an order with nothing disputed, without a note and with a day of the future', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId } = await disputed(db);
      const plainOrder = await soldOrder(db, 1);
      await asAdmin(db);
      const byAdmin = await settle(db, orderId, false, 'Lost.', NOW);
      await asRoot(db);
      return {
        byAdmin,
        nothing: await settle(db, plainOrder.orderId, true, 'Won.', NOW),
        noNote: await settle(db, orderId, false, ' ', NOW),
        future: await settle(db, orderId, false, 'Lost.', `${NOW} + interval '1 day'`),
      };
    });

    for (const [outcome, code] of [
      [outcomes.byAdmin, 'RETURN_FORBIDDEN'],
      [outcomes.nothing, 'RETURN_NOT_DISPUTED'],
      [outcomes.noNote, 'RETURN_OUTSIDE_NOTE_REQUIRED'],
      [outcomes.future, 'RETURN_OUTSIDE_AT_INVALID'],
    ] as const) {
      expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
    }
  });

  // a chargeback is the end of a dispute only: root never records it by hand
  it('keeps the way chargeback to the end of a dispute (RETURN_OUTSIDE_METHOD_INVALID)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      const started = await begin(db, returnId);
      if (!started.ok) throw new Error(started.message ?? 'refused');
      await finish(db, started.rows[0]!.done.key, 'failed', { failure: 'shop_balance' });
      await asRoot(db);
      return outside(db, returnId, { method: 'chargeback', at: await paidAtOf(db, orderId) });
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_OUTSIDE_METHOD_INVALID'),
    });
  });
});

// the shape of the rows a function is given: the routes check it first,
// the functions hold the same for any other caller
describe('the guards of the functions of the money', () => {
  it('refuses a row named by no id in each function that takes rows (RETURN_ITEMS_INVALID)', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      await asAdmin(db);
      const created = await db.attempt(
        `select cartlify.create_return(
           $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
           'defect'::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null, null, 4,
           'Europe/Madrid'
         ) as id`,
        orderId,
        JSON.stringify([{ orderItemId: 'one', quantity: 1 }]),
      );
      const returnId = await statementOf(db, orderId, itemId, 2);
      const received = await receive(db, returnId, [
        { itemId: 'one' as unknown as number, quantity: 1, goods: 'to_stock' },
      ]);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 2, goods: 'to_stock' }]);
      await asRoot(db);
      const reduced = await begin(db, returnId, [row!.id], [{ itemId: 'one', amount: 1 }]);
      return { created, received, reduced };
    });

    for (const outcome of Object.values(outcomes)) {
      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_ITEMS_INVALID'),
      });
    }
  });
});

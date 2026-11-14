import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inCommittedTx, inRolledBackTx, type DbSession, type Outcome } from '../../helpers/db.js';
import {
  paidOrderOf,
  pay,
  stockOf,
  waitingOrderOf,
  type DeliveryRule,
} from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';
import { publishContractIn, returnParcelIn, withdrawalStatementIn } from '../../helpers/returns.js';

// the money of the statements in the database, on the money journal: how a transfer back is
// started for rows of a statement (begin_return_refund writes it in parts under one key: the goods,
// the delivery, the way back the buyer owes), what each answer of the provider does to the parts
// and to the rows (settle_money_refund), the money root sends outside the app
// (mark_return_refunded_outside: all the statement owes), the way back the shop pays the buyer (a
// part of the transfer, or outside the app), the
// rows root closes without a refund (close_return_without_refund), the goods of a row whose money
// is settled or failed, the sum a statement gave back (returns.refundedTotal) and what stops a
// transfer: a dispute of the payment open at the bank, a refund made by hand that waits for root,
// what is left of the payment. All in transactions that roll back; a case that needs a row only the
// owner of the database writes (a dispute, the decision on a refund by hand) runs as the owner on an
// order the test commits. The money that already reached the buyer another way and covers a
// transfer (the part covered) comes with the functions that tie it to a statement
// (handRefunds.test.ts, disputes.test.ts)

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let plain: TestProduct;
// the product of the orders a test commits: the owner is another connection and finds only
// committed rows, and their units never come back to the stock of plain
let held: TestProduct;

beforeAll(async () => {
  buyer = await createUser({ name: 'Anna Koval' });
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  plain = await createProduct({ price: 10, stock: 60 });
  held = await createProduct({ price: 10, stock: 40 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

// the statements a helper runs: the session of the app (cartlify_app) or the one of the owner
type Session = Pick<DbSession, 'as' | 'rows' | 'attempt'>;

const asAdmin = (db: Session) => db.as({ role: 'ADMIN', userId: admin.id });
const asRoot = (db: Session) => db.as({ role: 'ROOT', userId: root.id });
// the server acting by itself: the payment webhook, the worker
const asSystem = (db: Session) => db.as({ role: 'ADMIN' });
const asBuyer = (db: Session) => db.as({ role: 'USER', userId: buyer.id });

const DELIVERY_FIVE: DeliveryRule = { flat: 5 };

type Sold = { orderId: number; itemId: number; paymentId: string };

// a paid order of the units asked of a product at 10 each, with the delivery rule given
async function soldOrder(
  db: DbSession,
  units: number,
  rule: DeliveryRule = {},
  product: TestProduct = plain,
): Promise<Sold> {
  const orderId = await paidOrderOf(db, buyer.id, admin.id, [[product.variantId, units]], rule);
  await asAdmin(db);
  const [row] = await db.rows<{ itemId: number; paymentId: string }>(
    `select i.id as "itemId", o."paymentId"
     from cartlify.orders as o join cartlify.order_items as i on i."orderId" = o.id
     where o.id = $1 order by i.id limit 1`,
    orderId,
  );
  return { orderId, itemId: row!.itemId, paymentId: row!.paymentId };
}

// a statement of an admin for units of the item; its id
async function statementOf(db: Session, orderId: number, itemId: number, quantity: number) {
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

const receive = (db: Session, returnId: number, results: Result[]) =>
  db.attempt(
    `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
    returnId,
    JSON.stringify(results),
  );

const confirmProof = (db: Session, returnId: number) =>
  db.attempt(`select 1 as done from cartlify.confirm_return_proof($1::int, 0::numeric)`, returnId);

type Row = {
  id: number;
  quantity: number;
  goods: string;
  money: string;
  amount: number;
  amountNote: string | null;
  refusedCode: string | null;
  moneyLogId: number | null;
};

const rowsOf = async (db: Session, returnId: number) => {
  await asAdmin(db);
  return db.rows<Row>(
    `select id, quantity, goods::text as goods, money::text as money, amount::float8 as amount,
            "amountNote", "refusedCode"::text as "refusedCode", "moneyLogId"
     from cartlify.return_items where "returnId" = $1 order by id`,
    returnId,
  );
};

type Line = {
  id: number;
  event: string;
  purpose: string;
  part: string;
  amount: string;
  state: string | null;
  stateAt: string | null;
  refundId: string | null;
  transferKey: string | null;
  coversId: number | null;
  failure: string | null;
  failureText: string | null;
  method: string | null;
  note: string | null;
  happenedAt: string | null;
  orderId: number | null;
  userId: number | null;
  returnId: number | null;
  orderShipmentId: number | null;
  provider: string | null;
  paymentId: string | null;
  actorId: number | null;
  meta: unknown;
};

// the lines of the money journal of a statement, oldest first, as an admin reads them
const linesOf = async (db: Session, returnId: number) => {
  await asAdmin(db);
  return db.rows<Line>(
    `select id, event, purpose::text as purpose, part::text as part, amount::text as amount,
            state::text as state, "stateAt"::text as "stateAt", "refundId", "transferKey",
            "coversId", failure::text as failure, "failureText", method::text as method, note,
            "happenedAt"::text as "happenedAt", "orderId", "userId", "returnId",
            "orderShipmentId", provider::text as provider, "paymentId", "actorId", meta
     from cartlify.money_log where "returnId" = $1 order by id`,
    returnId,
  );
};

const ofEvent = (lines: Line[], event: string) => lines.filter((line) => line.event === event);

// what a line of an event is made of: its parts and their sums, oldest first
const partsOf = (lines: Line[], event = 'money.refund') =>
  ofEvent(lines, event).map((line) => [line.part, line.amount]);

const goodsOf = (lines: Line[], event = 'money.refund') =>
  ofEvent(lines, event).find((line) => line.part === 'goods');

type Share = {
  returnItemId: number;
  productId: number;
  variantId: number;
  amount: number;
  quantity: number;
};

// the rows a line of the goods pays, from its meta: the reports share the money by product from it
const sharesOf = (line: Line | undefined): Share[] =>
  ((line?.meta ?? []) as Array<Record<string, unknown>>).map((share) => ({
    returnItemId: Number(share.returnItemId),
    productId: Number(share.productId),
    variantId: Number(share.variantId),
    amount: Number(share.amount),
    quantity: Number(share.quantity),
  }));

// the sum of the money the statement gave back, as the database keeps it next to the statement
const totalOf = async (db: Session, returnId: number) => {
  await asAdmin(db);
  const [row] = await db.rows<{ total: string }>(
    `select "refundedTotal"::text as total from cartlify.returns where id = $1`,
    returnId,
  );
  return row!.total;
};

// what the statement still owes, as its card tells it (return_money_left)
async function moneyLeftOf(db: Session, returnId: number) {
  await asAdmin(db);
  const [row] = await db.rows<{ left: Record<string, unknown> }>(
    'select cartlify.return_money_left($1::int) as left',
    returnId,
  );
  return row!.left;
}

type Beginning = {
  key: string | null;
  returnId: number;
  orderId: number;
  provider: string;
  paymentId: string;
  amount: string;
  itemIds: number[];
  lowered: Array<{ itemId: number; from: string; to: string; note: string | null }>;
  deduction: string;
  covered: string;
  settled: boolean;
};

const begin = (
  db: Session,
  returnId: number,
  itemIds: number[] | null = null,
  reductions: unknown = null,
  deduction: number | null = null,
) =>
  db.attempt<{ done: Beginning }>(
    `select cartlify.begin_return_refund($1::int, $2::int[], $3::jsonb, $4::numeric) as done`,
    returnId,
    itemIds,
    reductions === null ? null : JSON.stringify(reductions),
    deduction,
  );

// the answer of a function that has to work
function done<T>(outcome: Outcome<{ done: T }>): T {
  if (!outcome.ok) throw new Error(`refused: ${outcome.message}`);
  return outcome.rows[0]!.done;
}

type Settled = {
  changed: boolean;
  status: string;
  returnId?: number;
  orderId?: number;
  amount?: string;
  sentBack?: boolean;
  itemIds?: number[];
};

// the end of a transfer, as the provider tells it (the request, the webhook, the worker)
const settle = (
  db: Session,
  key: string | null,
  status: string,
  opts: { refundId?: string | null; failure?: string; text?: string } = {},
) =>
  db.attempt<{ done: Settled }>(
    `select cartlify.settle_money_refund(
       $1::text, $2::text, $3::text, $4::cartlify."RefundFailure", $5::text
     ) as done`,
    key,
    opts.refundId ?? null,
    status,
    opts.failure ?? null,
    opts.text ?? null,
  );

const outside = (
  db: Session,
  returnId: number,
  opts: {
    ids?: number[] | null;
    method?: string | null;
    note?: string;
    at: string;
    deduction?: number | null;
  },
) =>
  db.attempt<{ done: { returnId: number; orderId: number; amount: string; itemIds: number[] } }>(
    `select cartlify.mark_return_refunded_outside(
       $1::int, $2::int[], $3::cartlify."OutsideMethod", $4::text, $5::timestamp, $6::numeric
     ) as done`,
    returnId,
    opts.ids ?? null,
    opts.method === undefined ? 'bank_transfer' : opts.method,
    opts.note ?? 'Sent to the account of the buyer.',
    opts.at,
    opts.deduction ?? null,
  );

const closeRows = (
  db: Session,
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

// a refund made by hand in the dashboard of the provider, as the webhook records it
const handRefund = async (
  db: Session,
  paymentId: string,
  refundId: string,
  amount: number,
  status = 'succeeded',
) => {
  await asSystem(db);
  const outcome = await db.attempt<{ result: { id: number } }>(
    `select cartlify.record_hand_refund(
       'stripe'::cartlify."PaymentProvider", $1, $2, $3::numeric, $4, 'eur'
     ) as result`,
    paymentId,
    refundId,
    amount,
    status,
  );
  if (!outcome.ok) throw new Error(`record_hand_refund refused: ${outcome.message}`);
  return outcome.rows[0]!.result.id;
};

const stateOf = async (db: Session, orderId: number, returnId: number) => {
  await asAdmin(db);
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

const paidAtOf = async (db: Session, orderId: number) => {
  await asAdmin(db);
  const [row] = await db.rows<{ at: string }>(
    `select "paidAt"::text as at from cartlify.orders where id = $1`,
    orderId,
  );
  return row!.at;
};

// a statement whose units are on the shelf, ready for their money
async function comeBack(db: Session, orderId: number, itemId: number, units: number) {
  const returnId = await statementOf(db, orderId, itemId, units);
  const [row] = await rowsOf(db, returnId);
  await receive(db, returnId, [{ itemId: row!.id, quantity: units, goods: 'to_stock' }]);
  return returnId;
}

// a withdrawal from a paid order of units at 10 whose units came back in one row, with a parcel
// back the shop paid; the contract says who pays the way back
async function withdrawal(
  db: DbSession,
  payer: 'buyer' | 'shop',
  cost = 7,
  units = 2,
  rule: DeliveryRule = {},
) {
  await publishContractIn(db, root.id, payer);
  const { orderId, itemId } = await soldOrder(db, units, rule);
  const returnId = await withdrawalStatementIn(db, admin.id, orderId, itemId, units);
  await returnParcelIn(db, admin.id, returnId, cost);
  const [row] = await rowsOf(db, returnId);
  await receive(db, returnId, [{ itemId: row!.id, quantity: units, goods: 'to_stock' }]);
  await asAdmin(db);
  return { orderId, returnId };
}

// a transfer of a statement of two units that failed with the reason
async function failedTransfer(db: DbSession, failure: string, rule: DeliveryRule = {}) {
  const { orderId, itemId } = await soldOrder(db, 2, rule);
  const returnId = await comeBack(db, orderId, itemId, 2);
  const started = done(await begin(db, returnId));
  await asAdmin(db);
  done(await settle(db, started.key, 'failed', { failure, text: 'The card is closed.' }));
  return { orderId, returnId };
}

type Committed = Sold & { returnId: number; rowIds: number[] };

// an order of units of held that the test commits, with a statement whose units came back, in one
// row or a row for each unit; the owner, another connection, finds it
const committedStatement = (units: number, rows: 'one' | 'apart' = 'one') =>
  inCommittedTx(async (db): Promise<Committed> => {
    const sold = await soldOrder(db, units, {}, held);
    const returnId = await statementOf(db, sold.orderId, sold.itemId, units);
    for (let left = units; left > 0;) {
      const waiting = (await rowsOf(db, returnId)).find((row) => row.goods === 'expected')!;
      const quantity = rows === 'one' ? left : 1;
      await receive(db, returnId, [{ itemId: waiting.id, quantity, goods: 'to_stock' }]);
      left -= quantity;
    }
    return { ...sold, returnId, rowIds: (await rowsOf(db, returnId)).map((row) => row.id) };
  });

const KEY = /^refund:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('begin_return_refund', () => {
  it('writes the transfer of the rows that came back into the money journal under a key of its own, in transit', async () => {
    const result = await inRolledBackTx(async (db) => {
      const sold = await soldOrder(db, 3, DELIVERY_FIVE);
      const returnId = await comeBack(db, sold.orderId, sold.itemId, 2);
      const outcome = await begin(db, returnId);
      return {
        sold,
        returnId,
        outcome,
        lines: await linesOf(db, returnId),
        rows: await rowsOf(db, returnId),
        state: await stateOf(db, sold.orderId, returnId),
        total: await totalOf(db, returnId),
      };
    });

    const started = done(result.outcome);
    // 2 of the 3 units: no delivery goes back, the order is not whole
    expect(started).toMatchObject({
      key: expect.stringMatching(KEY),
      returnId: result.returnId,
      orderId: result.sold.orderId,
      amount: '20.00',
      provider: 'stripe',
      paymentId: result.sold.paymentId,
      itemIds: [result.rows[0]!.id],
      deduction: '0.00',
      covered: '0.00',
      settled: false,
    });
    expect(result.lines).toEqual([
      expect.objectContaining({
        event: 'money.refund',
        purpose: 'return',
        part: 'goods',
        amount: '-20.00',
        state: 'in_transit',
        stateAt: expect.any(String),
        transferKey: started.key,
        refundId: null,
        provider: 'stripe',
        paymentId: result.sold.paymentId,
        orderId: result.sold.orderId,
        userId: buyer.id,
        returnId: result.returnId,
        actorId: admin.id,
      }),
    ]);
    // the rows it pays, so the reports share it by product whatever the rows become later
    expect(sharesOf(result.lines[0])).toEqual([
      {
        returnItemId: result.rows[0]!.id,
        productId: plain.id,
        variantId: plain.variantId,
        amount: 20,
        quantity: 2,
      },
    ]);
    expect(result.rows).toEqual([
      expect.objectContaining({ money: 'pending', moneyLogId: result.lines[0]!.id }),
    ]);
    // money on its way is not money back: the statement is open and the order says so
    expect(result.state).toMatchObject({ status: 'open', closedAt: null });
    // what is on its way counts for the sum the statement gives back
    expect(result.total).toBe('20.00');
  });

  it('adds the delivery, all of it, as a part of the transfer that makes the order whole', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const outcome = await begin(db, returnId);
      return { outcome, lines: await linesOf(db, returnId), total: await totalOf(db, returnId) };
    });

    const started = done(result.outcome);
    expect(started.amount).toBe('25.00');
    expect(partsOf(result.lines)).toEqual([
      ['goods', '-20.00'],
      ['delivery', '-5.00'],
    ]);
    expect(result.lines.every((line) => line.transferKey === started.key)).toBe(true);
    expect(result.total).toBe('25.00');
  });

  it('gives the delivery to the statement that completes the order, not to the first', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const first = await comeBack(db, orderId, itemId, 1);
      const second = await comeBack(db, orderId, itemId, 1);
      const a = done(await begin(db, first));
      const b = done(await begin(db, second));
      return {
        a: a.amount,
        b: b.amount,
        first: partsOf(await linesOf(db, first)),
        second: partsOf(await linesOf(db, second)),
      };
    });

    expect(result).toEqual({
      a: '10.00',
      b: '15.00',
      first: [['goods', '-10.00']],
      second: [
        ['goods', '-10.00'],
        ['delivery', '-5.00'],
      ],
    });
  });

  // a row whose transfer failed is still owed its money: it counts for the order to be whole, so
  // the delivery is never left without a transfer to go with
  it('gives the delivery to the transfer that completes the order when a row of it failed before', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const first = await comeBack(db, orderId, itemId, 1);
      const second = await comeBack(db, orderId, itemId, 1);
      const a = done(await begin(db, first));
      await asAdmin(db);
      done(await settle(db, a.key, 'failed', { failure: 'shop_balance' }));
      const b = done(await begin(db, second));
      return { b: b.amount, second: partsOf(await linesOf(db, second)) };
    });

    expect(result).toEqual({
      b: '15.00',
      second: [
        ['goods', '-10.00'],
        ['delivery', '-5.00'],
      ],
    });
  });

  it('starts a new try of rows whose transfer failed under a new key, with the delivery the failure gave back', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const first = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, first.key, 'failed', { failure: 'shop_balance' }));
      const afterFailure = await totalOf(db, returnId);
      // by default: the rows whose transfer failed wait for their money as any other
      const again = done(await begin(db, returnId));
      const lines = await linesOf(db, returnId);
      return {
        first,
        again,
        afterFailure,
        parts: ofEvent(lines, 'money.refund')
          .filter((line) => line.transferKey === again.key)
          .map((line) => [line.part, line.amount]),
        goods: lines.find((line) => line.transferKey === again.key && line.part === 'goods'),
        rows: await rowsOf(db, returnId),
        total: await totalOf(db, returnId),
      };
    });

    expect(result.again).toMatchObject({ amount: '25.00', key: expect.stringMatching(KEY) });
    expect(result.again.key).not.toBe(result.first.key);
    expect(result.parts).toEqual([
      ['goods', '-20.00'],
      ['delivery', '-5.00'],
    ]);
    expect(result.rows).toEqual([
      expect.objectContaining({ money: 'pending', moneyLogId: result.goods!.id }),
    ]);
    expect(result.afterFailure).toBe('0.00');
    expect(result.total).toBe('25.00');
  });

  it('gives no delivery to a transfer while another transfer of the order carries it', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const first = await comeBack(db, orderId, itemId, 1);
      const second = await comeBack(db, orderId, itemId, 1);
      const a = done(await begin(db, first));
      await asAdmin(db);
      done(await settle(db, a.key, 'failed', { failure: 'shop_balance' }));
      // the second makes the order whole and takes the delivery
      done(await begin(db, second));
      const again = done(await begin(db, first));
      return { again: again.amount, delivery: partsOf(await linesOf(db, first)) };
    });

    expect(result.again).toBe('10.00');
    expect(result.delivery.filter(([part]) => part === 'delivery')).toEqual([]);
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
      return { outcome: await begin(db, returnId), lines: await linesOf(db, returnId) };
    });

    expect(done(result.outcome).amount).toBe('10.00');
    expect(partsOf(result.lines)).toEqual([['goods', '-10.00']]);
  });

  it('takes by default the rows that came back; a row that still waits for its goods needs the proof first', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await statementOf(db, orderId, itemId, 2);
      const [row] = await rowsOf(db, returnId);
      const nothing = await begin(db, returnId);
      const ahead = await begin(db, returnId, [row!.id]);
      await confirmProof(db, returnId);
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
    expect(done(result.proven).amount).toBe('20.00');
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
      await asAdmin(db);
      return begin(db, returnId, ids);
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it('is for an admin or root: a buyer is refused (RETURN_FORBIDDEN), a statement that is not there is not found', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      await asBuyer(db);
      const byBuyer = await begin(db, returnId);
      await asAdmin(db);
      return {
        byBuyer,
        missing: await begin(db, 2_147_483_000),
        rows: await rowsOf(db, returnId),
        lines: await linesOf(db, returnId),
      };
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
    expect(outcomes.lines).toEqual([]);
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
      return {
        byAdmin,
        byRoot,
        rows: await rowsOf(db, returnId),
        lines: await linesOf(db, returnId),
      };
    });

    expect(result.byAdmin).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
    expect(done(result.byRoot)).toMatchObject({
      amount: '15.00',
      lowered: [
        { itemId: result.rows[0]!.id, from: '20.00', to: '15.00', note: 'Opened and used.' },
      ],
    });
    expect(result.rows).toEqual([
      expect.objectContaining({ amount: 15, amountNote: 'Opened and used.', money: 'pending' }),
    ]);
    expect(partsOf(result.lines)).toEqual([['goods', '-15.00']]);
    expect(sharesOf(result.lines[0])).toEqual([
      expect.objectContaining({ amount: 15, quantity: 2 }),
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
        lines: await linesOf(db, returnId),
      };
    });

    expect(result.outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
    expect(result.rows).toEqual([
      expect.objectContaining({
        money: 'not_refunded',
        moneyLogId: null,
        amount: 20,
        amountNote: null,
      }),
    ]);
    expect(result.lines).toEqual([]);
  });
});

// the way back: the contract says who pays it. When the buyer does and the shop paid the carrier, a
// transfer of a withdrawal takes it off (at most what the parcels cost, from the money journal);
// when the shop does and the buyer paid the carrier, root records the money paid back outside the app
describe('the cost of the way back', () => {
  it('takes what the buyer owes off the transfer as a part of its own', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'buyer');
      const started = await begin(db, returnId, null, null, 5);
      return {
        started,
        rows: await rowsOf(db, returnId),
        lines: await linesOf(db, returnId),
        total: await totalOf(db, returnId),
      };
    });

    const started = done(result.started);
    expect(started).toMatchObject({ amount: '15.00', deduction: '5.00' });
    expect(partsOf(result.lines)).toEqual([
      ['goods', '-20.00'],
      ['deduction', '5.00'],
    ]);
    expect(
      ofEvent(result.lines, 'money.refund').every((line) => line.transferKey === started.key),
    ).toBe(true);
    expect(result.rows).toEqual([expect.objectContaining({ money: 'pending', amount: 20 })]);
    // the buyer gets 15: the parcel the shop paid is not money of the buyer
    expect(result.total).toBe('15.00');
  });

  it('takes no more than the parcels of the statement cost (RETURN_DEDUCTION_EXCEEDS_COST)', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'buyer', 7);
      const above = await begin(db, returnId, null, null, 7.01);
      const all = await begin(db, returnId, null, null, 7);
      return { above, all };
    });

    expect(outcomes.above).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_DEDUCTION_EXCEEDS_COST'),
    });
    expect(done(outcomes.all)).toMatchObject({ amount: '13.00', deduction: '7.00' });
  });

  it('counts what the parcels cost from the money journal: a corrected cost moves the most a transfer may take off', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'buyer', 7);
      await asAdmin(db);
      const [parcel] = await db.rows<{ id: number }>(
        `select id from cartlify.order_shipments where "returnId" = $1`,
        returnId,
      );
      await db.rows(`select cartlify.set_return_shipment_cost($1::int, 9) as done`, parcel!.id);
      const above = await begin(db, returnId, null, null, 9.01);
      const all = await begin(db, returnId, null, null, 9);
      return { above, all };
    });

    expect(outcomes.above).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_DEDUCTION_EXCEEDS_COST'),
    });
    expect(done(outcomes.all)).toMatchObject({ amount: '11.00', deduction: '9.00' });
  });

  it('takes off at most what other transfers left of the cost, and a failed transfer gives back what it took', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await publishContractIn(db, root.id, 'buyer');
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await withdrawalStatementIn(db, admin.id, orderId, itemId, 2);
      await returnParcelIn(db, admin.id, returnId, 7);
      // the units come back in two steps, so the statement has two rows to pay apart
      const [whole] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: whole!.id, quantity: 1, goods: 'to_stock' }]);
      const waiting = (await rowsOf(db, returnId)).find((row) => row.goods === 'expected');
      await receive(db, returnId, [{ itemId: waiting!.id, quantity: 1, goods: 'to_stock' }]);
      const [first, second] = await rowsOf(db, returnId);

      await asAdmin(db);
      const five = done(await begin(db, returnId, [first!.id], null, 5));
      const aboveLeft = await begin(db, returnId, [second!.id], null, 2.01);
      await asAdmin(db);
      done(await settle(db, five.key, 'failed', { failure: 'shop_balance' }));
      const allAgain = await begin(db, returnId, [second!.id], null, 7);
      return { aboveLeft, allAgain };
    });

    expect(outcomes.aboveLeft).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_DEDUCTION_EXCEEDS_COST'),
    });
    expect(done(outcomes.allAgain)).toMatchObject({ amount: '3.00', deduction: '7.00' });
  });

  // the next try of the rows of a failed transfer takes the way back off again, as the money outside
  // the app does: the buyer would get the deduction too otherwise
  it('takes off again what a failed transfer of the rows took for the way back', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'buyer');
      const first = done(await begin(db, returnId, null, null, 5));
      await asAdmin(db);
      done(await settle(db, first.key, 'failed', { failure: 'card_unavailable' }));
      const again = done(await begin(db, returnId));
      return { first, again };
    });

    expect(result.first).toMatchObject({ amount: '15.00', deduction: '5.00' });
    expect(result.again).toMatchObject({ amount: '15.00', deduction: '5.00' });
  });

  // an order that kept no contract (none was published when it was confirmed) is refused the same
  // way: the buyer was told nothing, so the shop pays (the shared database of the tests may hold a
  // contract of another file, so that order cannot be made here)
  it('takes nothing when the contract says the shop pays (RETURN_DEDUCTION_NOT_ALLOWED)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'shop');
      return begin(db, returnId, null, null, 5);
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
      const returnId = await statementOf(db, orderId, itemId, 1);
      await returnParcelIn(db, admin.id, returnId, 7);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
      await asAdmin(db);
      return begin(db, returnId, null, null, 5);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_DEDUCTION_NOT_ALLOWED'),
    });
  });

  it('never leaves a transfer of nothing (RETURN_DEDUCTION_INVALID)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { returnId } = await withdrawal(db, 'buyer', 30);
      return begin(db, returnId, null, null, 20);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_DEDUCTION_INVALID'),
    });
  });

  // a withdrawal of three units of a paid order of a contract that makes the shop pay the way back,
  // for some of the units: the buyer paid the carrier, the receipt says so many, and the units come
  // in one by one with the parcel confirmed as the first comes in
  async function wayBackOwed(db: DbSession, buyerPaid: number, units = 2) {
    await publishContractIn(db, root.id, 'shop');
    const { orderId, itemId, paymentId } = await soldOrder(db, 3);
    const returnId = await withdrawalStatementIn(db, admin.id, orderId, itemId, units);
    const [row] = await rowsOf(db, returnId);
    await asAdmin(db);
    await db.rows(
      `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, $3::jsonb)`,
      returnId,
      JSON.stringify([{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]),
      JSON.stringify({ buyerPaid }),
    );
    return { orderId, itemId, returnId, paymentId };
  }

  // the units of the statement that still wait come in
  async function restComesIn(db: DbSession, returnId: number) {
    const waiting = (await rowsOf(db, returnId)).filter((row) => row.goods === 'expected');
    for (const row of waiting) {
      const taken = await receive(db, returnId, [
        { itemId: row.id, quantity: row.quantity, goods: 'to_stock' },
      ]);
      if (!taken.ok) throw new Error(`receive_return_items refused: ${taken.message}`);
    }
  }

  it('sends the way back the shop pays with the transfer that ends the money of the statement, as a part of its own, once', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { returnId } = await wayBackOwed(db, 6.5);
      const came = (await rowsOf(db, returnId)).find((row) => row.goods === 'to_stock')!;
      const first = done(await begin(db, returnId, [came.id]));
      // the unit still on its way is paid ahead: its parcel is confirmed
      const last = done(await begin(db, returnId));
      return {
        first,
        last,
        lines: await linesOf(db, returnId),
        total: await totalOf(db, returnId),
      };
    });

    // the first transfer leaves a unit owed: the way back waits for the last, the goods go first
    expect(result.first).toMatchObject({ amount: '10.00' });
    expect(result.last).toMatchObject({ amount: '16.50' });
    expect(partsOf(result.lines)).toEqual([
      ['goods', '-10.00'],
      ['goods', '-10.00'],
      ['way_back', '-6.50'],
    ]);
    const wayBack = ofEvent(result.lines, 'money.refund').find((line) => line.part === 'way_back');
    const lastGoods = ofEvent(result.lines, 'money.refund')[1]!;
    expect(wayBack).toMatchObject({
      purpose: 'return',
      state: 'in_transit',
      transferKey: lastGoods.transferKey,
    });
    expect(result.total).toBe('26.50');
  });

  it('leaves the way back owed when the payment cannot hold it with the goods: the goods go alone', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { returnId } = await wayBackOwed(db, 6.5, 3);
      await restComesIn(db, returnId);
      const sent = done(await begin(db, returnId));
      return { sent, lines: await linesOf(db, returnId) };
    });

    // the whole of the order came back: the payment holds the goods and no more
    expect(result.sent).toMatchObject({ amount: '30.00' });
    expect(partsOf(result.lines)).toEqual([['goods', '-30.00']]);
  });

  it.each([
    ['the contract makes the buyer pay it', 'buyer', 6.5],
    ['the receipt says nothing was paid', 'shop', 0],
  ] as const)('sends no way back when %s', async (_what, payer, buyerPaid) => {
    const lines = await inRolledBackTx(async (db) => {
      await publishContractIn(db, root.id, payer);
      const { orderId, itemId } = await soldOrder(db, 3);
      const returnId = await withdrawalStatementIn(db, admin.id, orderId, itemId, 1);
      const [row] = await rowsOf(db, returnId);
      await asAdmin(db);
      await db.rows(
        `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, $3::jsonb)`,
        returnId,
        JSON.stringify([{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]),
        JSON.stringify(payer === 'buyer' ? {} : { buyerPaid }),
      );
      done(await begin(db, returnId));
      return linesOf(db, returnId);
    });

    expect(partsOf(lines)).toEqual([['goods', '-10.00']]);
  });

  it('sends no way back for a parcel the shop paid the carrier for', async () => {
    const lines = await inRolledBackTx(async (db) => {
      await publishContractIn(db, root.id, 'shop');
      const { orderId, itemId } = await soldOrder(db, 3);
      const returnId = await withdrawalStatementIn(db, admin.id, orderId, itemId, 1);
      await returnParcelIn(db, admin.id, returnId, 7);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
      done(await begin(db, returnId));
      return linesOf(db, returnId);
    });

    expect(partsOf(lines)).toEqual([['goods', '-10.00']]);
  });

  it('leaves room in the payment for the goods another statement of the order still owes: the way back waits', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId, returnId } = await wayBackOwed(db, 6.5, 1);
      // a second statement of the order for the two other units, which wait for their goods
      const other = await withdrawalStatementIn(db, admin.id, orderId, itemId, 2);
      const first = done(await begin(db, returnId));
      return { first, other, lines: await linesOf(db, returnId) };
    });

    // 10 and 6.50 would leave 13.50 of the 30 paid, the other statement owes 20
    expect(result.first).toMatchObject({ amount: '10.00' });
    expect(partsOf(result.lines)).toEqual([['goods', '-10.00']]);
  });

  // what the statement still owes, as its card and the alert of the money read it
  // the way back is owed like the goods: a statement whose rows got their money stays open
  // while it is owed, and a way back the payment cannot hold goes outside the app, the alert of the
  // money that does not fit tells it
  it('keeps the statement open while the way back the payment could not hold is owed, until it goes outside the app', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await wayBackOwed(db, 6.5, 3);
      await restComesIn(db, returnId);
      const sent = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, sent.key, 'succeeded', { refundId: 're_1' }));
      const afterGoods = await stateOf(db, orderId, returnId);
      const left = await moneyLeftOf(db, returnId);
      const at = await paidAtOf(db, orderId);
      await asRoot(db);
      const paid = done(await outside(db, returnId, { at }));
      return { afterGoods, left, paid, end: await stateOf(db, orderId, returnId) };
    });

    expect(result.afterGoods.closedAt).toBeNull();
    expect(result.left).toMatchObject({ rows: '0.00', wayBack: '6.50', short: true });
    expect(result.paid).toMatchObject({ amount: '6.50' });
    expect(result.end.closedAt).not.toBeNull();
  });

  // the way back goes with the transfer of the goods when it can, and by a transfer of its own when it
  // is left alone: while the other statements of the order
  // still owe what is left of the payment it has no room, then it has
  it('sends a way back left alone by a transfer of its own once the payment has room for it', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId, returnId } = await wayBackOwed(db, 6.5, 1);
      const other = await withdrawalStatementIn(db, admin.id, orderId, itemId, 2);
      const first = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, first.key, 'succeeded', { refundId: 're_1' }));
      const waiting = await moneyLeftOf(db, returnId);
      const noRoom = await begin(db, returnId);
      // the units of the other statement never came: root closes them, their money is refused
      await asRoot(db);
      done(await closeRows(db, other, { code: 'goods_not_returned', note: 'Never sent.' }));
      const room = await moneyLeftOf(db, returnId);
      const alone = done(await begin(db, returnId));
      const inTransit = await stateOf(db, orderId, returnId);
      await asAdmin(db);
      done(await settle(db, alone.key, 'succeeded', { refundId: 're_2' }));
      return {
        waiting,
        noRoom,
        room,
        alone,
        inTransit,
        lines: await linesOf(db, returnId),
        end: await stateOf(db, orderId, returnId),
      };
    });

    // 6.50 does not fit beside the 20 the other statement owes of the 20 left
    expect(result.waiting).toMatchObject({ rows: '0.00', wayBack: '6.50', short: true });
    expect(result.noRoom).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_REFUND_EXCEEDS_PAID'),
    });
    expect(result.room).toMatchObject({ wayBack: '6.50', short: false });
    expect(result.alone).toMatchObject({ amount: '6.50', wayBack: '6.50', itemIds: [] });
    expect(result.alone.key).toEqual(expect.stringMatching(KEY));
    // open while it is on its way, closed once it is sent
    expect(result.inTransit.closedAt).toBeNull();
    expect(partsOf(result.lines).slice(-1)).toEqual([['way_back', '-6.50']]);
    expect(result.end.closedAt).not.toBeNull();
  });

  it('keeps the statement open when a transfer of the way back alone failed, to send it again', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId, returnId } = await wayBackOwed(db, 6.5, 1);
      const other = await withdrawalStatementIn(db, admin.id, orderId, itemId, 2);
      const first = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, first.key, 'succeeded', { refundId: 're_1' }));
      await asRoot(db);
      done(await closeRows(db, other, { code: 'goods_not_returned', note: 'Never sent.' }));
      const alone = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, alone.key, 'failed', { failure: 'card_unavailable' }));
      return {
        state: await stateOf(db, orderId, returnId),
        left: await moneyLeftOf(db, returnId),
        again: done(await begin(db, returnId)),
      };
    });

    expect(result.state.closedAt).toBeNull();
    expect(result.left).toMatchObject({ wayBack: '6.50' });
    expect(result.again).toMatchObject({ amount: '6.50', itemIds: [] });
  });

  // the shop pays no way back of goods it refused, whoever the contract says pays it (docs/return-scenarios.md, 12): none is owed, the statement closes
  it('owes no way back for a statement whose goods were all refused, and closes it', async () => {
    const result = await inRolledBackTx(async (db) => {
      await publishContractIn(db, root.id, 'shop');
      const { orderId, itemId } = await soldOrder(db, 3);
      const returnId = await withdrawalStatementIn(db, admin.id, orderId, itemId, 1);
      const [row] = await rowsOf(db, returnId);
      await asAdmin(db);
      await db.rows(
        `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, $3::jsonb)`,
        returnId,
        JSON.stringify([
          { itemId: row!.id, quantity: 1, goods: 'not_accepted', notAcceptedReason: 'used' },
        ]),
        JSON.stringify({ buyerPaid: 6.5 }),
      );
      return { state: await stateOf(db, orderId, returnId), left: await moneyLeftOf(db, returnId) };
    });

    expect(result.state.closedAt).not.toBeNull();
    expect(result.left).toMatchObject({ wayBack: '0.00', total: '0.00', short: false });
  });

  it('sends the way back again after the transfer that took it failed', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { returnId } = await wayBackOwed(db, 6.5, 1);
      const first = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, first.key, 'failed', { failure: 'card_unavailable' }));
      const again = done(await begin(db, returnId));
      return { again, lines: await linesOf(db, returnId), total: await totalOf(db, returnId) };
    });

    expect(result.again).toMatchObject({ amount: '16.50' });
    expect(partsOf(result.lines, 'money.refund').filter(([part]) => part === 'way_back')).toEqual([
      ['way_back', '-6.50'],
      ['way_back', '-6.50'],
    ]);
    expect(result.total).toBe('16.50');
  });
});

// the end of a transfer of a statement: what the provider says moves the parts and the rows. The
// refusals of the function itself (a status that is none, a failure without its reason, a buyer)
// are the same for every refund: moneyPayments.test.ts
describe('settle_money_refund for a transfer of a statement', () => {
  it('sends every part when the provider says so: the rows are refunded and the order is full once the units and the delivery are back', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const started = done(await begin(db, returnId));
      await asAdmin(db);
      const settled = await settle(db, started.key, 'succeeded', { refundId: 're_1' });
      return {
        returnId,
        settled,
        lines: await linesOf(db, returnId),
        rows: await rowsOf(db, returnId),
        state: await stateOf(db, orderId, returnId),
        total: await totalOf(db, returnId),
      };
    });

    expect(done(result.settled)).toMatchObject({
      changed: true,
      status: 'succeeded',
      returnId: result.returnId,
      amount: '25.00',
      sentBack: false,
    });
    expect(result.lines.map((line) => [line.part, line.amount, line.state, line.refundId])).toEqual(
      [
        ['goods', '-20.00', 'sent', 're_1'],
        ['delivery', '-5.00', 'sent', 're_1'],
      ],
    );
    expect(result.rows).toEqual([
      expect.objectContaining({ money: 'refunded', moneyLogId: result.lines[0]!.id }),
    ]);
    expect(result.state).toMatchObject({
      status: 'full',
      closedAt: expect.any(String),
      closedById: admin.id,
    });
    expect(result.total).toBe('25.00');
  });

  it('reverses each part of a transfer that failed with a line of its own, and the rows owe their money again', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const started = done(await begin(db, returnId));
      await asAdmin(db);
      const failed = await settle(db, started.key, 'failed', {
        failure: 'card_unavailable',
        text: 'The card is closed.',
      });
      return {
        returnId,
        failed,
        lines: await linesOf(db, returnId),
        rows: await rowsOf(db, returnId),
        state: await stateOf(db, orderId, returnId),
        total: await totalOf(db, returnId),
      };
    });

    expect(done(result.failed)).toMatchObject({
      changed: true,
      status: 'failed',
      returnId: result.returnId,
      amount: '25.00',
      sentBack: false,
    });
    const parts = ofEvent(result.lines, 'money.refund');
    const failures = ofEvent(result.lines, 'money.refund_failed');
    expect(failures).toHaveLength(2);
    expect(
      parts.map((part) => {
        const failure = failures.find((line) => line.coversId === part.id);
        return (
          failure && [
            failure.purpose,
            failure.part,
            failure.amount,
            failure.failure,
            failure.failureText,
          ]
        );
      }),
    ).toEqual([
      ['return', 'goods', '20.00', 'card_unavailable', 'The card is closed.'],
      ['return', 'delivery', '5.00', 'card_unavailable', 'The card is closed.'],
    ]);
    // the lines of the transfer stay as they were: a line is history
    expect(parts.map((line) => line.state)).toEqual(['in_transit', 'in_transit']);
    // the failure of the goods names the same rows, so a report of the period of the failure takes
    // the same products back
    const goodsFailure = failures.find((line) => line.part === 'goods');
    expect(sharesOf(goodsFailure)).toEqual(sharesOf(goodsOf(parts)));
    expect(result.rows).toEqual([
      expect.objectContaining({ money: 'failed', moneyLogId: goodsFailure!.id }),
    ]);
    expect(result.state).toMatchObject({ status: 'open', closedAt: null });
    expect(result.total).toBe('0.00');
  });

  // the bank of a card that is gone sends the money of a refund back: the provider fails the refund
  // it had made, the rows wait for their money again and the statement is open
  it('reverses a transfer the provider failed after it was sent and opens the statement again, once', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const started = done(await begin(db, returnId));
      await asAdmin(db);
      const key = started.key;
      await settle(db, key, 'succeeded', { refundId: 're_1' });
      const closed = await stateOf(db, orderId, returnId);
      const sentTotal = await totalOf(db, returnId);
      const failure = { failure: 'card_unavailable', text: 'expired_or_canceled_card' };
      // a refund the lines were not sent by is not theirs
      const other = await settle(db, key, 'failed', { refundId: 're_other', ...failure });
      const back = await settle(db, key, 'failed', { refundId: 're_1', ...failure });
      const again = await settle(db, key, 'failed', { refundId: 're_1', ...failure });
      return {
        closed,
        sentTotal,
        other,
        back,
        again,
        lines: await linesOf(db, returnId),
        rows: await rowsOf(db, returnId),
        state: await stateOf(db, orderId, returnId),
        total: await totalOf(db, returnId),
      };
    });

    expect(result.closed).toMatchObject({ status: 'full', closedAt: expect.any(String) });
    expect(result.sentTotal).toBe('25.00');
    expect(done(result.other)).toMatchObject({ changed: false });
    expect(done(result.back)).toMatchObject({
      changed: true,
      status: 'failed',
      amount: '25.00',
      sentBack: true,
    });
    expect(done(result.again)).toMatchObject({ changed: false });
    const failures = ofEvent(result.lines, 'money.refund_failed');
    expect(failures.map((line) => [line.part, line.amount, line.refundId])).toEqual([
      ['goods', '20.00', 're_1'],
      ['delivery', '5.00', 're_1'],
    ]);
    // the parts were sent: that stays true of them
    expect(ofEvent(result.lines, 'money.refund').map((line) => line.state)).toEqual([
      'sent',
      'sent',
    ]);
    expect(result.rows).toEqual([
      expect.objectContaining({
        money: 'failed',
        moneyLogId: failures.find((line) => line.part === 'goods')!.id,
      }),
    ]);
    expect(result.state).toMatchObject({ status: 'open', closedAt: null, closedById: null });
    expect(result.total).toBe('0.00');
  });

  it('says partial when only some of the units went back, and the system may settle it too', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2, DELIVERY_FIVE);
      const returnId = await comeBack(db, orderId, itemId, 1);
      const started = done(await begin(db, returnId));
      await asSystem(db);
      done(await settle(db, started.key, 'succeeded', { refundId: 're_2' }));
      return { state: await stateOf(db, orderId, returnId) };
    });

    // the statement is over, the order is not whole: the delivery stayed
    expect(result.state).toMatchObject({
      status: 'partial',
      closedAt: expect.any(String),
      closedById: null,
    });
  });

  it('keeps the parts on their way while the provider is still deciding, and keeps its id', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      const started = done(await begin(db, returnId));
      const key = started.key;
      await asAdmin(db);
      const pending = await settle(db, key, 'pending', { refundId: 're_3' });
      const afterPending = { lines: await linesOf(db, returnId), rows: await rowsOf(db, returnId) };
      await asAdmin(db);
      const settled = await settle(db, key, 'succeeded');
      return {
        pending,
        afterPending,
        settled,
        lines: await linesOf(db, returnId),
        rows: await rowsOf(db, returnId),
      };
    });

    expect(done(result.pending).changed).toBe(false);
    expect(result.afterPending.lines).toEqual([
      expect.objectContaining({ state: 'in_transit', refundId: 're_3' }),
    ]);
    expect(result.afterPending.rows).toEqual([expect.objectContaining({ money: 'pending' })]);
    expect(done(result.settled).changed).toBe(true);
    // the id the provider gave stays when the end comes without one
    expect(result.lines).toEqual([expect.objectContaining({ state: 'sent', refundId: 're_3' })]);
    expect(result.rows).toEqual([expect.objectContaining({ money: 'refunded' })]);
  });

  it('changes nothing the second time, for a key nobody knows, and for a failure that names no refund after the parts were sent', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      const started = done(await begin(db, returnId));
      const key = started.key;
      await asAdmin(db);
      await settle(db, key, 'succeeded', { refundId: 're_4' });
      return {
        again: await settle(db, key, 'succeeded', { refundId: 're_4' }),
        failedAfter: await settle(db, key, 'failed', { failure: 'unknown' }),
        stranger: await settle(db, 'refund:11111111-1111-4111-8111-111111111111', 'succeeded'),
        lines: await linesOf(db, returnId),
        rows: await rowsOf(db, returnId),
      };
    });

    for (const outcome of [result.again, result.failedAfter, result.stranger]) {
      expect(done(outcome).changed).toBe(false);
    }
    expect(result.lines).toEqual([expect.objectContaining({ state: 'sent', refundId: 're_4' })]);
    expect(result.rows).toEqual([expect.objectContaining({ money: 'refunded' })]);
  });

  it('does not send a transfer whose failure came first: the late word of success changes nothing', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      const started = done(await begin(db, returnId));
      await asAdmin(db);
      await settle(db, started.key, 'failed', { refundId: 're_5', failure: 'shop_balance' });
      const late = await settle(db, started.key, 'succeeded', { refundId: 're_5' });
      return {
        late,
        lines: await linesOf(db, returnId),
        rows: await rowsOf(db, returnId),
        total: await totalOf(db, returnId),
      };
    });

    expect(done(result.late).changed).toBe(false);
    expect(ofEvent(result.lines, 'money.refund').map((line) => line.state)).toEqual(['in_transit']);
    expect(result.rows).toEqual([expect.objectContaining({ money: 'failed' })]);
    expect(result.total).toBe('0.00');
  });
});

describe('mark_return_refunded_outside', () => {
  it('records money sent outside the app in parts, on the day it really went, and the rows are refunded', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await failedTransfer(db, 'card_unavailable', DELIVERY_FIVE);
      const at = await paidAtOf(db, orderId);
      await asRoot(db);
      return {
        at,
        recorded: await outside(db, returnId, { at }),
        lines: await linesOf(db, returnId),
        rows: await rowsOf(db, returnId),
        state: await stateOf(db, orderId, returnId),
        total: await totalOf(db, returnId),
      };
    });

    // by default every row whose transfer failed; the delivery goes with the rows that make the
    // order whole, as with a transfer (the failed one gave it back)
    expect(done(result.recorded)).toMatchObject({
      amount: '25.00',
      itemIds: [result.rows[0]!.id],
    });
    const sent = ofEvent(result.lines, 'money.outside');
    expect(sent.map((line) => [line.purpose, line.part, line.amount])).toEqual([
      ['return', 'goods', '-20.00'],
      ['return', 'delivery', '-5.00'],
    ]);
    for (const line of sent) {
      expect(line).toMatchObject({
        method: 'bank_transfer',
        note: 'Sent to the account of the buyer.',
        happenedAt: result.at,
        state: null,
        actorId: root.id,
        userId: buyer.id,
      });
    }
    expect(sharesOf(goodsOf(result.lines, 'money.outside'))).toEqual([
      expect.objectContaining({ returnItemId: result.rows[0]!.id, amount: 20, quantity: 2 }),
    ]);
    expect(result.rows).toEqual([
      expect.objectContaining({
        money: 'refunded',
        moneyLogId: goodsOf(result.lines, 'money.outside')!.id,
      }),
    ]);
    expect(result.state).toMatchObject({ status: 'full', closedById: root.id });
    expect(result.total).toBe('25.00');
  });

  it('takes off the way back the failed transfer meant to take', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await withdrawal(db, 'buyer', 7);
      const started = done(await begin(db, returnId, null, null, 5));
      await asAdmin(db);
      done(await settle(db, started.key, 'failed', { failure: 'card_unavailable' }));
      const at = await paidAtOf(db, orderId);
      await asRoot(db);
      return {
        recorded: await outside(db, returnId, { at }),
        lines: await linesOf(db, returnId),
        total: await totalOf(db, returnId),
      };
    });

    expect(done(result.recorded).amount).toBe('15.00');
    expect(partsOf(result.lines, 'money.outside')).toEqual([
      ['goods', '-20.00'],
      ['deduction', '5.00'],
    ]);
    expect(result.total).toBe('15.00');
  });

  it.each([
    ['an admin', 'RETURN_FORBIDDEN'],
    ['a buyer', 'RETURN_FORBIDDEN'],
  ])('is refused to %s (%s)', async (who, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await failedTransfer(db, 'unknown');
      const at = await paidAtOf(db, orderId);
      if (who === 'an admin') await asAdmin(db);
      else await asBuyer(db);
      return outside(db, returnId, { at });
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it('records rows never tried too, not a row whose money is on its way (RETURN_ITEM_NOT_REFUNDABLE)', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await statementOf(db, orderId, itemId, 2);
      const [whole] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: whole!.id, quantity: 1, goods: 'to_stock' }]);
      const waiting = (await rowsOf(db, returnId)).find((row) => row.goods === 'expected');
      await receive(db, returnId, [{ itemId: waiting!.id, quantity: 1, goods: 'to_stock' }]);
      const [first, second] = await rowsOf(db, returnId);
      done(await begin(db, returnId, [second!.id]));
      const at = await paidAtOf(db, orderId);
      await asRoot(db);
      return {
        neverTried: await outside(db, returnId, { at, ids: [first!.id] }),
        onItsWay: await outside(db, returnId, { at, ids: [second!.id] }),
      };
    });

    expect(outcomes.neverTried.ok).toBe(true);
    expect(outcomes.onItsWay).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEM_NOT_REFUNDABLE'),
    });
  });

  it('pays outside the app the way back a transfer could not hold, once (RETURN_NOTHING_OWED)', async () => {
    const result = await inRolledBackTx(async (db) => {
      await publishContractIn(db, root.id, 'shop');
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await withdrawalStatementIn(db, admin.id, orderId, itemId, 2);
      const [row] = await rowsOf(db, returnId);
      await asAdmin(db);
      await db.rows(
        `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, $3::jsonb)`,
        returnId,
        JSON.stringify([{ itemId: row!.id, quantity: 2, goods: 'to_stock' }]),
        JSON.stringify({ buyerPaid: 6.5 }),
      );
      const sent = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, sent.key, 'succeeded', { refundId: `re_${randomUUID()}` }));
      const at = await paidAtOf(db, orderId);
      await asRoot(db);
      const paid = await outside(db, returnId, { at });
      const again = await outside(db, returnId, { at });
      return {
        paid,
        again,
        lines: await linesOf(db, returnId),
        total: await totalOf(db, returnId),
      };
    });

    expect(done(result.paid)).toMatchObject({ amount: '6.50', itemIds: [] });
    expect(partsOf(result.lines, 'money.outside')).toEqual([['way_back', '-6.50']]);
    expect(result.again).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_NOTHING_OWED'),
    });
    expect(result.total).toBe('26.50');
  });

  it('takes the way back the buyer owes off the money sent outside the app', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, returnId } = await withdrawal(db, 'buyer', 7);
      const at = await paidAtOf(db, orderId);
      await asRoot(db);
      return {
        above: await outside(db, returnId, { at, deduction: 7.01 }),
        recorded: await outside(db, returnId, { at, deduction: 5 }),
        lines: await linesOf(db, returnId),
      };
    });

    expect(result.above).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_DEDUCTION_EXCEEDS_COST'),
    });
    expect(done(result.recorded).amount).toBe('15.00');
    expect(partsOf(result.lines, 'money.outside')).toEqual([
      ['goods', '-20.00'],
      ['deduction', '5.00'],
    ]);
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
        lines: await linesOf(db, returnId),
      };
    });

    expect(result.outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
    expect(result.rows).toEqual([expect.objectContaining({ money: 'failed' })]);
    expect(ofEvent(result.lines, 'money.outside')).toEqual([]);
  });
});

describe('close_return_without_refund', () => {
  it('closes the rows that wait for goods that never came, with the code and the note, and leaves the stock and the money', async () => {
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
        lines: await linesOf(db, returnId),
        total: await totalOf(db, returnId),
        before,
        after: await stockOf(db, admin.id, plain.variantId),
      };
    });

    expect(done(result.outcome).closed).toBe(true);
    expect(result.rows).toEqual([
      expect.objectContaining({
        goods: 'not_arrived',
        money: 'refused',
        refusedCode: 'buyer_changed_mind',
        moneyLogId: null,
      }),
    ]);
    expect(result.state).toMatchObject({
      status: 'declined',
      closeCode: 'buyer_changed_mind',
      closeNote: 'Wrote us they keep it.',
      closedById: root.id,
    });
    expect(result.lines).toEqual([]);
    expect(result.total).toBe('0.00');
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

    expect(done(result.outcome).closed).toBe(false);
    expect(result.rows.map((row) => [row.goods, row.money])).toEqual([
      ['not_arrived', 'refused'],
      ['to_stock', 'not_refunded'],
    ]);
  });

  // the money of goods that wait was tried ahead (the proof was confirmed) and failed; the goods
  // never came, so nothing is owed for them
  it('closes a row whose goods wait and whose transfer failed: the money it never sent is not owed', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      await asAdmin(db);
      await confirmProof(db, returnId);
      const started = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, started.key, 'failed', { failure: 'card_unavailable' }));
      const [row] = await rowsOf(db, returnId);
      await asRoot(db);
      return {
        outcome: await closeRows(db, returnId, { ids: [row!.id] }),
        rows: await rowsOf(db, returnId),
        state: await stateOf(db, orderId, returnId),
        total: await totalOf(db, returnId),
      };
    });

    expect(done(result.outcome).closed).toBe(true);
    expect(result.rows).toEqual([
      expect.objectContaining({ goods: 'not_arrived', money: 'refused', moneyLogId: null }),
    ]);
    expect(result.state).toMatchObject({ status: 'declined', closedAt: expect.any(String) });
    expect(result.total).toBe('0.00');
  });

  it.each([
    ['an admin', 'RETURN_FORBIDDEN'],
    ['a buyer', 'RETURN_FORBIDDEN'],
  ])('is refused to %s (%s)', async (who, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      if (who === 'an admin') await asAdmin(db);
      else await asBuyer(db);
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
      await confirmProof(db, returnId);
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
      await confirmProof(db, returnId);
      const started = done(await begin(db, returnId));
      const linesBefore = await linesOf(db, returnId);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
      const split = await rowsOf(db, returnId);
      await asAdmin(db);
      const settled = await settle(db, started.key, 'succeeded', { refundId: 're_9' });
      return {
        row: row!,
        linesBefore,
        split,
        settled,
        lines: await linesOf(db, returnId),
        rows: await rowsOf(db, returnId),
      };
    });

    const goods = goodsOf(result.linesBefore)!;
    // 20 split by the units: 10 and 10, the same line of the transfer
    expect(
      result.split.map((row) => [row.quantity, row.amount, row.money, row.moneyLogId]),
    ).toEqual([
      [1, 10, 'pending', goods.id],
      [1, 10, 'pending', goods.id],
    ]);
    // the line keeps the row it paid as it was when the money went
    expect(sharesOf(goodsOf(result.lines))).toEqual([
      expect.objectContaining({ returnItemId: result.row.id, amount: 20, quantity: 2 }),
    ]);
    expect(done(result.settled).itemIds).toHaveLength(2);
    expect(result.rows.map((row) => [row.money, row.moneyLogId])).toEqual([
      ['refunded', goods.id],
      ['refunded', goods.id],
    ]);
  });

  it('lets goods that wait come back after the money paid ahead failed: both rows owe it, and go again in one transfer', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await statementOf(db, orderId, itemId, 2);
      await asAdmin(db);
      await confirmProof(db, returnId);
      const started = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, started.key, 'failed', { failure: 'shop_balance' }));
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
      const split = await rowsOf(db, returnId);
      const failure = goodsOf(await linesOf(db, returnId), 'money.refund_failed');
      const again = done(await begin(db, returnId));
      const lines = await linesOf(db, returnId);
      return {
        split,
        failure: failure!,
        again,
        goods: lines.find((line) => line.transferKey === again.key && line.part === 'goods'),
      };
    });

    expect(result.split.map((row) => [row.quantity, row.money, row.moneyLogId])).toEqual([
      [1, 'failed', result.failure.id],
      [1, 'failed', result.failure.id],
    ]);
    expect(result.again).toMatchObject({ amount: '20.00', itemIds: result.split.map((r) => r.id) });
    expect(sharesOf(result.goods).map((share) => [share.returnItemId, share.amount])).toEqual(
      result.split.map((row) => [row.id, 10]),
    );
  });

  it('refuses to not accept goods whose money is on its way or back (RETURN_ITEM_MONEY_SETTLED)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      await asAdmin(db);
      await confirmProof(db, returnId);
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

  it('gives up the money of a row whose transfer failed when its goods then never arrive; the journal keeps the failure', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1, DELIVERY_FIVE);
      const returnId = await statementOf(db, orderId, itemId, 1);
      await asAdmin(db);
      await confirmProof(db, returnId);
      const started = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, started.key, 'failed', { failure: 'unknown', text: 'Try later.' }));
      const linesBefore = await linesOf(db, returnId);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'not_arrived' }]);
      return {
        linesBefore,
        rows: await rowsOf(db, returnId),
        lines: await linesOf(db, returnId),
        state: await stateOf(db, orderId, returnId),
        total: await totalOf(db, returnId),
      };
    });

    expect(result.rows).toEqual([
      expect.objectContaining({ goods: 'not_arrived', money: 'refused', moneyLogId: null }),
    ]);
    expect(result.lines).toEqual(result.linesBefore);
    expect(result.state).toMatchObject({ status: 'declined', closedAt: expect.any(String) });
    expect(result.total).toBe('0.00');
  });

  // the money went back ahead of the goods and the parcel never came: the goods are not arrived,
  // the money stays refunded (the shop gets it back outside the app), the stock does not move, and
  // the statement is over
  it('records goods paid ahead that never arrive: the money stays refunded, the stock stays', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      await asAdmin(db);
      await confirmProof(db, returnId);
      const started = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, started.key, 'succeeded', { refundId: 're_ahead' }));
      const before = await stockOf(db, admin.id, plain.variantId);
      const [row] = await rowsOf(db, returnId);
      await asAdmin(db);
      const outcome = await receive(db, returnId, [
        { itemId: row!.id, quantity: 1, goods: 'not_arrived' },
      ]);
      return {
        outcome,
        rows: await rowsOf(db, returnId),
        goods: goodsOf(await linesOf(db, returnId)),
        before,
        after: await stockOf(db, admin.id, plain.variantId),
        state: await stateOf(db, orderId, returnId),
        total: await totalOf(db, returnId),
      };
    });

    expect(result.outcome.ok).toBe(true);
    expect(result.rows).toEqual([
      expect.objectContaining({
        goods: 'not_arrived',
        money: 'refunded',
        moneyLogId: result.goods!.id,
      }),
    ]);
    expect(result.after).toEqual(result.before);
    expect(result.state.closedAt).toEqual(expect.any(String));
    expect(result.total).toBe('10.00');
  });

  it('still refuses goods that never arrive while their money is on its way (RETURN_ITEM_MONEY_SETTLED)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await statementOf(db, orderId, itemId, 1);
      await asAdmin(db);
      await confirmProof(db, returnId);
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

// the sum the buyer has back by the statement, kept next to it: the transfers (on their way and
// sent) less what failed, the money sent outside the app, the way back paid back; never what the
// shop pays a carrier
describe('the sum a statement gave back', () => {
  it('follows each step of the money: 102 on its way and sent, 0 when it failed, 102 again outside the app', async () => {
    const result = await inRolledBackTx(async (db) => {
      // ten units at 10 and a delivery of 10; the buyer pays the way back, the parcel cost 8
      const { orderId, returnId } = await withdrawal(db, 'buyer', 8, 10, { flat: 10 });
      const afterParcel = await totalOf(db, returnId);
      const started = done(await begin(db, returnId, null, null, 8));
      const inTransit = await totalOf(db, returnId);
      await asAdmin(db);
      done(await settle(db, started.key, 'succeeded', { refundId: 're_102' }));
      const sent = await totalOf(db, returnId);
      await asSystem(db);
      const back = { refundId: 're_102', failure: 'card_unavailable' };
      done(await settle(db, started.key, 'failed', back));
      const failed = await totalOf(db, returnId);
      const at = await paidAtOf(db, orderId);
      await asRoot(db);
      done(await outside(db, returnId, { at }));
      return {
        started,
        afterParcel,
        inTransit,
        sent,
        failed,
        lines: await linesOf(db, returnId),
        total: await totalOf(db, returnId),
      };
    });

    expect(result.started.amount).toBe('102.00');
    expect(partsOf(result.lines)).toEqual([
      ['goods', '-100.00'],
      ['delivery', '-10.00'],
      ['deduction', '8.00'],
    ]);
    expect(partsOf(result.lines, 'money.return_parcel_cost')).toEqual([['whole', '-8.00']]);
    expect(partsOf(result.lines, 'money.outside')).toEqual([
      ['goods', '-100.00'],
      ['delivery', '-10.00'],
      ['deduction', '8.00'],
    ]);
    expect({
      afterParcel: result.afterParcel,
      inTransit: result.inTransit,
      sent: result.sent,
      failed: result.failed,
      outside: result.total,
    }).toEqual({
      afterParcel: '0.00',
      inTransit: '102.00',
      sent: '102.00',
      failed: '0.00',
      outside: '102.00',
    });
  });
});

// a dispute of the payment at the bank: the bank gives the money back, a transfer would pay it
// twice. The disputes are written by the function that follows the provider (disputes.test.ts);
// here the row is written as the owner, on an order the test commits
describe('a dispute of the payment open at the bank', () => {
  let statement: Committed;

  beforeAll(async () => {
    statement = await committedStatement(2);
  });

  const ENDED = ['won', 'lost', 'prevented', 'warning_closed'];

  async function disputeOf(
    q: Session,
    status: string,
    opts: { refundable?: boolean; paymentId?: string } = {},
  ) {
    await asSystem(q);
    const ended = ENDED.includes(status);
    const outcome = await q.attempt(
      `insert into cartlify.payment_disputes
         (provider, "stripeId", "paymentId", "orderId", "userId", status, "isChargeRefundable",
          "openedAt", "closedAt")
       values ('stripe', $1, $2, $3::int, $4::int, $5::cartlify."DisputeStatus", $6::boolean,
               now() at time zone 'UTC', case when $7::boolean then now() at time zone 'UTC' end)
       returning id`,
      `dp_${randomUUID()}`,
      opts.paymentId ?? statement.paymentId,
      opts.paymentId ? null : statement.orderId,
      buyer.id,
      status,
      opts.refundable ?? false,
      ended,
    );
    if (!outcome.ok) throw new Error(`the dispute was refused: ${outcome.message}`);
  }

  it.each([
    ['needs_response'],
    ['under_review'],
    ['warning_needs_response'],
    ['warning_under_review'],
  ])(
    'stops a transfer of the order while a dispute is %s (RETURN_REFUND_DISPUTED), and writes nothing',
    async (status) => {
      const result = await inOwnerTx(async (q) => {
        await disputeOf(q, status);
        await asAdmin(q);
        return {
          outcome: await begin(q, statement.returnId),
          rows: await rowsOf(q, statement.returnId),
          lines: await linesOf(q, statement.returnId),
        };
      });

      expect(result.outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_REFUND_DISPUTED'),
      });
      expect(result.rows.map((row) => row.money)).toEqual(['not_refunded']);
      expect(result.lines).toEqual([]);
    },
  );

  it('lets the transfer go while the provider says the payment can still be refunded to settle the dispute', async () => {
    const outcome = await inOwnerTx(async (q) => {
      await disputeOf(q, 'needs_response', { refundable: true });
      await asAdmin(q);
      return begin(q, statement.returnId);
    });

    expect(done(outcome).amount).toBe('20.00');
  });

  it.each(ENDED.map((status) => [status]))(
    'lets the transfer go once the dispute is %s',
    async (status) => {
      const outcome = await inOwnerTx(async (q) => {
        await disputeOf(q, status);
        await asAdmin(q);
        return begin(q, statement.returnId);
      });

      expect(done(outcome).amount).toBe('20.00');
    },
  );

  it('looks at the payment of the order only: a dispute of another payment stops nothing', async () => {
    const outcome = await inOwnerTx(async (q) => {
      await disputeOf(q, 'needs_response', { paymentId: `pi_other_${randomUUID()}` });
      await asAdmin(q);
      return begin(q, statement.returnId);
    });

    expect(done(outcome).amount).toBe('20.00');
  });

  it('stops the money sent outside the app too (RETURN_REFUND_DISPUTED)', async () => {
    const result = await inOwnerTx(async (q) => {
      await asAdmin(q);
      const started = done(await begin(q, statement.returnId));
      await asAdmin(q);
      done(await settle(q, started.key, 'failed', { failure: 'disputed' }));
      await disputeOf(q, 'needs_response');
      const at = await paidAtOf(q, statement.orderId);
      await asRoot(q);
      return {
        outcome: await outside(q, statement.returnId, { at }),
        rows: await rowsOf(q, statement.returnId),
      };
    });

    expect(result.outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_REFUND_DISPUTED'),
    });
    expect(result.rows.map((row) => row.money)).toEqual(['failed']);
  });

  // the table of the disputes says whether one is open: a transfer that failed because the buyer
  // disputed the payment may go again once the dispute is over (or was never recorded)
  it('is decided by the disputes of the payment, not by the reason of a failure', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 1);
      const returnId = await comeBack(db, orderId, itemId, 1);
      const started = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, started.key, 'failed', { failure: 'disputed' }));
      return { again: await begin(db, returnId), rows: await rowsOf(db, returnId) };
    });

    expect(done(result.again).amount).toBe('10.00');
    expect(result.rows).toEqual([expect.objectContaining({ money: 'pending' })]);
  });
});

// a refund made by hand in the dashboard of the provider may be what the buyer is owed: until root
// says what it was (or ties it to a statement), a transfer of the order would send the money twice
describe('a refund made by hand that waits for root', () => {
  it.each([
    ['sent', 'succeeded'],
    ['still on its way', 'pending'],
  ])(
    'stops a transfer of the order while the refund by hand is %s (RETURN_HAND_REFUND_PENDING)',
    async (_how, status) => {
      const result = await inRolledBackTx(async (db) => {
        const { orderId, itemId, paymentId } = await soldOrder(db, 2);
        const returnId = await comeBack(db, orderId, itemId, 2);
        await handRefund(db, paymentId, `re_hand_${randomUUID()}`, 5, status);
        await asAdmin(db);
        return {
          outcome: await begin(db, returnId),
          rows: await rowsOf(db, returnId),
          lines: await linesOf(db, returnId),
        };
      });

      expect(result.outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_HAND_REFUND_PENDING'),
      });
      expect(result.rows.map((row) => row.money)).toEqual(['not_refunded']);
      expect(result.lines).toEqual([]);
    },
  );

  it('stops the money sent outside the app too (RETURN_HAND_REFUND_PENDING)', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId, paymentId } = await soldOrder(db, 2);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const started = done(await begin(db, returnId));
      await asAdmin(db);
      done(await settle(db, started.key, 'failed', { failure: 'card_unavailable' }));
      await handRefund(db, paymentId, `re_hand_${randomUUID()}`, 5);
      const at = await paidAtOf(db, orderId);
      await asRoot(db);
      return { outcome: await outside(db, returnId, { at }), rows: await rowsOf(db, returnId) };
    });

    expect(result.outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_HAND_REFUND_PENDING'),
    });
    expect(result.rows.map((row) => row.money)).toEqual(['failed']);
  });

  it('stops nothing once the refund by hand failed: no money went', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId, paymentId } = await soldOrder(db, 2);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const refundId = `re_hand_${randomUUID()}`;
      await handRefund(db, paymentId, refundId, 5, 'pending');
      await asSystem(db);
      done(await settle(db, null, 'failed', { refundId, failure: 'card_unavailable' }));
      await asAdmin(db);
      return begin(db, returnId);
    });

    expect(done(outcome).amount).toBe('20.00');
  });

  it('stops nothing for a refund by hand of another order', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, itemId } = await soldOrder(db, 2);
      const returnId = await comeBack(db, orderId, itemId, 2);
      const other = await soldOrder(db, 1);
      await handRefund(db, other.paymentId, `re_hand_${randomUUID()}`, 5);
      await asAdmin(db);
      return begin(db, returnId);
    });

    expect(done(outcome).amount).toBe('20.00');
  });
});

// what root decided a refund by hand was is written by the functions of root (handRefunds.test.ts);
// here the decision is written as the owner writes it, on an order the test commits: three units at
// 10, each a row of its own, and a refund by hand of the payment
describe('a refund by hand root decided on, and the most a transfer sends', () => {
  let statement: Committed;

  beforeAll(async () => {
    statement = await committedStatement(3, 'apart');
  });

  // the refund by hand, explained by root as a compensation for something the app does not follow
  async function compensation(q: Session, amount: number) {
    const id = await handRefund(q, statement.paymentId, `re_hand_${randomUUID()}`, amount);
    const decided = await q.attempt(
      `update cartlify.money_log set "moneyUse" = 'compensation', meta = '[]'::jsonb where id = $1 returning id`,
      id,
    );
    if (!decided.ok) throw new Error(`the decision was refused: ${decided.message}`);
  }

  it('stops nothing once root decided it was a compensation', async () => {
    const outcome = await inOwnerTx(async (q) => {
      await compensation(q, 5);
      await asAdmin(q);
      return begin(q, statement.returnId, [statement.rowIds[0]!]);
    });

    expect(done(outcome).amount).toBe('10.00');
  });

  // the payment brought 30; 15 went back by hand, 10 by a transfer: 5 is left. A transfer of 20
  // sends what is left of the payment, taken off the last rows: a row is paid in parts, from the
  // provider and outside the app, and is paid once they give all of it
  it('sends what is left of the payment, the last rows owing the rest', async () => {
    const result = await inOwnerTx(async (q) => {
      await compensation(q, 15);
      await asAdmin(q);
      const first = await begin(q, statement.returnId, [statement.rowIds[0]!]);
      const rest = await begin(q, statement.returnId, statement.rowIds.slice(1));
      return {
        first,
        rest,
        rows: await rowsOf(q, statement.returnId),
        lines: await linesOf(q, statement.returnId),
      };
    });

    expect(done(result.first).amount).toBe('10.00');
    expect(done(result.rest)).toMatchObject({
      amount: '5.00',
      itemIds: [statement.rowIds[1]],
    });
    expect(result.rows.map((row) => row.money)).toEqual(['pending', 'pending', 'not_refunded']);
    const last = ofEvent(result.lines, 'money.refund').filter((line) => line.part === 'goods')[1];
    expect(sharesOf(last).map((share) => [share.returnItemId, share.amount])).toEqual([
      [statement.rowIds[1], 5],
    ]);
  });

  it('leaves the rest of a row paid in part to go outside the app: then the row is paid and the statement closed', async () => {
    const result = await inOwnerTx(async (q) => {
      await compensation(q, 15);
      await asAdmin(q);
      const sent = done(await begin(q, statement.returnId));
      done(await settle(q, sent.key, 'succeeded', { refundId: `re_${randomUUID()}` }));
      const afterSent = await rowsOf(q, statement.returnId);
      const left = await moneyLeftOf(q, statement.returnId);
      const again = await begin(q, statement.returnId);
      const at = await paidAtOf(q, statement.orderId);
      await asRoot(q);
      const rest = done(await outside(q, statement.returnId, { at }));
      return {
        sent,
        afterSent,
        left,
        again,
        rest,
        rows: await rowsOf(q, statement.returnId),
        lines: await linesOf(q, statement.returnId),
        total: await totalOf(q, statement.returnId),
        state: await stateOf(q, statement.orderId, statement.returnId),
      };
    });

    // 30 owed, 15 left of the payment: the first row whole, the second for 5 of its 10
    expect(result.sent).toMatchObject({
      amount: '15.00',
      itemIds: [statement.rowIds[0], statement.rowIds[1]],
    });
    expect(result.afterSent.map((row) => row.money)).toEqual([
      'refunded',
      'not_refunded',
      'not_refunded',
    ]);
    expect(result.left).toMatchObject({ rows: '15.00', paymentLeft: '0.00', short: true });
    expect(result.again).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_REFUND_EXCEEDS_PAID'),
    });
    // the rest: 5 of the second row, 10 of the third. The units of a row go with the part that ends
    // its money, so the reports count them once
    expect(result.rest).toMatchObject({
      amount: '15.00',
      itemIds: [statement.rowIds[1], statement.rowIds[2]],
    });
    const shares = (event: string) =>
      sharesOf(goodsOf(result.lines, event)).map((share) => [
        share.returnItemId,
        share.amount,
        share.quantity,
      ]);
    expect(shares('money.refund')).toEqual([
      [statement.rowIds[0], 10, 1],
      [statement.rowIds[1], 5, 0],
    ]);
    expect(shares('money.outside')).toEqual([
      [statement.rowIds[1], 5, 1],
      [statement.rowIds[2], 10, 1],
    ]);
    expect(result.rows.map((row) => row.money)).toEqual(['refunded', 'refunded', 'refunded']);
    expect(result.total).toBe('30.00');
    expect(result.state.closedAt).not.toBeNull();
  });

  it('gives back the part of a row whose transfer failed: the row owes all of it again', async () => {
    const result = await inOwnerTx(async (q) => {
      await compensation(q, 15);
      await asAdmin(q);
      const sent = done(await begin(q, statement.returnId));
      done(
        await settle(q, sent.key, 'failed', {
          refundId: `re_${randomUUID()}`,
          failure: 'card_unavailable',
        }),
      );
      return {
        rows: await rowsOf(q, statement.returnId),
        left: await moneyLeftOf(q, statement.returnId),
      };
    });

    expect(result.rows.map((row) => row.money)).toEqual(['failed', 'failed', 'not_refunded']);
    expect(result.left).toMatchObject({ rows: '30.00', paymentLeft: '15.00' });
  });

  it('opens the statement again when the bank sends back a part of a row whose rest went since: the row owes that part again', async () => {
    const result = await inOwnerTx(async (q) => {
      await compensation(q, 15);
      await asAdmin(q);
      const sent = done(await begin(q, statement.returnId));
      const refundId = `re_${randomUUID()}`;
      done(await settle(q, sent.key, 'succeeded', { refundId }));
      const at = await paidAtOf(q, statement.orderId);
      await asRoot(q);
      done(await outside(q, statement.returnId, { at }));
      const closed = await stateOf(q, statement.orderId, statement.returnId);
      // the bank of the card sends the transfer back
      await asAdmin(q);
      const back = done(
        await settle(q, sent.key, 'failed', { refundId, failure: 'card_unavailable' }),
      );
      return {
        closed,
        back,
        rows: await rowsOf(q, statement.returnId),
        left: await moneyLeftOf(q, statement.returnId),
        state: await stateOf(q, statement.orderId, statement.returnId),
      };
    });

    expect(result.closed.closedAt).not.toBeNull();
    // the first row was paid by the transfer, the second by it and by the money outside the app
    expect(result.back).toMatchObject({
      changed: true,
      sentBack: true,
      itemIds: [statement.rowIds[0], statement.rowIds[1]],
    });
    expect(result.rows.map((row) => row.money)).toEqual(['failed', 'failed', 'refunded']);
    expect(result.left).toMatchObject({ rows: '15.00' });
    expect(result.state.closedAt).toBeNull();
  });

  // the units the reports count for each row of the statement: what the lines of the goods gave,
  // less what the failures took back
  const unitsOf = (lines: Line[]) => {
    const units = new Map<number, number>();
    for (const line of lines.filter((one) => one.part === 'goods')) {
      const sign = line.event === 'money.refund_failed' ? -1 : 1;
      for (const share of sharesOf(line)) {
        units.set(share.returnItemId, (units.get(share.returnItemId) ?? 0) + sign * share.quantity);
      }
    }
    return statement.rowIds.map((id) => units.get(id));
  };

  // the second row had 5 from the transfer and its rest, with its units, outside the app; the
  // transfer came back and its part goes again: the units of the row went already
  it('counts the units of a row once when the part of it that failed goes again outside the app', async () => {
    const lines = await inOwnerTx(async (q) => {
      await compensation(q, 15);
      await asAdmin(q);
      const sent = done(await begin(q, statement.returnId));
      const refundId = `re_${randomUUID()}`;
      done(await settle(q, sent.key, 'succeeded', { refundId }));
      const at = await paidAtOf(q, statement.orderId);
      await asRoot(q);
      done(await outside(q, statement.returnId, { at }));
      await asAdmin(q);
      done(await settle(q, sent.key, 'failed', { refundId, failure: 'card_unavailable' }));
      await asRoot(q);
      done(await outside(q, statement.returnId, { at }));
      return linesOf(q, statement.returnId);
    });

    expect(unitsOf(lines)).toEqual([1, 1, 1]);
  });

  // the refund by hand failed and gave the payment its room back, so the rest of the second row
  // went by a second transfer, with its units; then the first transfer came back and its part goes
  // by a transfer again
  it('counts the units of a row once when the part of it that failed goes again by a transfer', async () => {
    const result = await inOwnerTx(async (q) => {
      const byHand = `re_hand_${randomUUID()}`;
      const handId = await handRefund(q, statement.paymentId, byHand, 15);
      const decided = await q.attempt(
        `update cartlify.money_log set "moneyUse" = 'compensation', meta = '[]'::jsonb where id = $1 returning id`,
        handId,
      );
      if (!decided.ok) throw new Error(`the decision was refused: ${decided.message}`);
      await asAdmin(q);
      const first = done(await begin(q, statement.returnId));
      const refundId = `re_${randomUUID()}`;
      done(await settle(q, first.key, 'succeeded', { refundId }));
      await asSystem(q);
      done(await settle(q, null, 'failed', { refundId: byHand, failure: 'card_unavailable' }));
      await asAdmin(q);
      const second = done(await begin(q, statement.returnId));
      done(await settle(q, second.key, 'succeeded', { refundId: `re_${randomUUID()}` }));
      done(await settle(q, first.key, 'failed', { refundId, failure: 'card_unavailable' }));
      const again = done(await begin(q, statement.returnId));
      return { first, second, again, lines: await linesOf(q, statement.returnId) };
    });

    expect(result.first).toMatchObject({ amount: '15.00' });
    expect(result.second).toMatchObject({ amount: '15.00' });
    expect(result.again).toMatchObject({
      amount: '15.00',
      itemIds: [statement.rowIds[0], statement.rowIds[1]],
    });
    expect(unitsOf(result.lines)).toEqual([1, 1, 1]);
  });

  it('lowers no row paid in part to what it had already (RETURN_AMOUNT_INVALID)', async () => {
    const result = await inOwnerTx(async (q) => {
      await compensation(q, 15);
      await asAdmin(q);
      const sent = done(await begin(q, statement.returnId));
      done(await settle(q, sent.key, 'succeeded', { refundId: `re_${randomUUID()}` }));
      const row = statement.rowIds[1]!;
      await asRoot(q);
      return {
        toPaid: await begin(
          q,
          statement.returnId,
          [row],
          [{ itemId: row, amount: 5, note: 'Scratched.' }],
        ),
        above: await begin(
          q,
          statement.returnId,
          [row],
          [{ itemId: row, amount: 8, note: 'Scratched.' }],
        ),
      };
    });

    // the second row had 5 of its 10
    expect(result.toPaid).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_AMOUNT_INVALID'),
    });
    // above it the sum is taken; nothing is left of the payment for the rest
    expect(result.above).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_REFUND_EXCEEDS_PAID'),
    });
  });

  it('keeps a row paid in part in its statement: a split does not take it (RETURN_ITEM_MONEY_SETTLED)', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId, paymentId } = await soldOrder(db, 2);
      const returnId = await statementOf(db, orderId, itemId, 2);
      await asAdmin(db);
      const proof = await confirmProof(db, returnId);
      if (!proof.ok) throw new Error(`the proof was refused: ${proof.message}`);
      const id = await handRefund(db, paymentId, `re_hand_${randomUUID()}`, 15);
      // root says the 15 were a compensation: 5 is left of the payment of 20
      await asRoot(db);
      const decided = await db.attempt(
        'select cartlify.decide_money_use($1::int, $2::jsonb, 0::numeric, $3) as done',
        id,
        '[]',
        'A gesture for the parcel that came late.',
      );
      if (!decided.ok) throw new Error(`the decision was refused: ${decided.message}`);
      await asAdmin(db);
      const sent = done(await begin(db, returnId));
      done(await settle(db, sent.key, 'succeeded', { refundId: `re_${randomUUID()}` }));
      const [row] = await rowsOf(db, returnId);
      await asAdmin(db);
      const split = await db.attempt(
        'select cartlify.split_return($1::int, $2::jsonb) as id',
        returnId,
        JSON.stringify([{ itemId: row!.id, quantity: 1 }]),
      );
      return { sent, row, split };
    });

    expect(result.sent).toMatchObject({ amount: '5.00' });
    expect(result.row).toMatchObject({ goods: 'expected', money: 'not_refunded' });
    expect(result.split).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEM_MONEY_SETTLED'),
    });
  });

  it('is refused when nothing is left of the payment (RETURN_REFUND_EXCEEDS_PAID)', async () => {
    const outcome = await inOwnerTx(async (q) => {
      await compensation(q, 30);
      await asAdmin(q);
      return begin(q, statement.returnId);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_REFUND_EXCEEDS_PAID'),
    });
  });
});

// the currency the provider charged in: the payment says it, and every line of the money of that
// payment takes it, the transfers of its statements too
describe('the currency of the money of a payment', () => {
  it('is on the lines of the payment and of the transfer of its statement', async () => {
    const currencies = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, buyer.id, [[plain.variantId, 1]]);
      const paid = await pay(db, admin.id, orderId, { currency: 'eur' });
      if (paid !== 'PAID') throw new Error(`pay_order answered ${paid}`);
      await asAdmin(db);
      const [item] = await db.rows<{ id: number }>(
        'select id from cartlify.order_items where "orderId" = $1',
        orderId,
      );
      await db.rows(
        `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
        orderId,
      );
      const returnId = await comeBack(db, orderId, item!.id, 1);
      done(await begin(db, returnId));
      await asAdmin(db);
      return db.rows<{ event: string; part: string; currency: string | null }>(
        `select event, part::text as part, currency from cartlify.money_log
         where "orderId" = $1 order by id`,
        orderId,
      );
    });

    expect(currencies.length).toBeGreaterThan(1);
    for (const line of currencies) expect(line).toMatchObject({ currency: 'eur' });
  });
});

// money already with the buyer for an item whose units came in with two results (two rows of the one
// item): the transfer of both rows takes the share for each, a part covered for each row
describe('a share that covers two rows of one item', () => {
  it('is taken by each row in one transfer, and the provider is asked for the rest', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, itemId, paymentId } = await soldOrder(db, 3);
      await asAdmin(db);
      await db.rows(
        `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
        orderId,
      );
      const hand = await handRefund(db, paymentId, `re_hand_${randomUUID()}`, 15);
      await asRoot(db);
      const decided = await db.attempt(
        `select cartlify.decide_money_use($1::int, $2::jsonb, 0, 'For two units.') as result`,
        hand,
        JSON.stringify([{ orderItemId: itemId, quantity: 2, amount: 15 }]),
      );
      if (!decided.ok) throw new Error(`decide_money_use refused: ${decided.message}`);
      const returnId = await statementOf(db, orderId, itemId, 2);
      const [row] = await rowsOf(db, returnId);
      await asAdmin(db);
      const taken = await receive(db, returnId, [
        { itemId: row!.id, quantity: 1, goods: 'to_stock' },
        { itemId: row!.id, quantity: 1, goods: 'written_off' },
      ]);
      if (!taken.ok) throw new Error(`receive_return_items refused: ${taken.message}`);
      return {
        sent: await begin(db, returnId),
        rows: await rowsOf(db, returnId),
        lines: await linesOf(db, returnId),
      };
    });

    expect(result.rows).toHaveLength(2);
    expect(done(result.sent)).toMatchObject({ amount: '5.00', covered: '15.00' });
    expect(partsOf(result.lines).filter(([part]) => part === 'covered')).toHaveLength(2);
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

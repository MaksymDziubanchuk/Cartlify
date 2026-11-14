import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { MONEY_LOG_EVENTS } from '@config/journalEvents.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, testTx } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { giveMoneyRight } from '../../../helpers/moneyManager.js';
import { placePaidOrderOf } from '../../../helpers/payments.js';

// GET /api/admin/money-log: the journal of every movement of money, a line for each part of each
// movement. The story below is made the way the app makes it: the orders are paid through the
// payment of the shop, the rest through the database functions the routes, the webhook and the
// worker call, each as its actor (an admin cancels an order and sends its money back in two
// transfers, the provider says the first went and the second failed, root sends the rest outside
// the app; a refund made by hand in the dashboard of the provider; a dispute at the bank). The
// journal is read by its filters, sorts, events, columns, period, cursor and csv. Other files write
// lines at the same time: a test narrows the journal to the buyers of the story

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
// an admin root allowed to handle the money
let cashier: TestUser;
let root: TestUser;
let buyer: TestUser;
let otherBuyer: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const AGENT = 'Cartlify money log test browser';
const ROOT_AGENT = 'Cartlify money log root browser';
const ADMIN_IP = '203.0.113.10';
const ROOT_IP = '198.51.100.7';
const NOTE = 'Sent by bank transfer';
const FAILURE_TEXT = 'The card is closed';

type Story = {
  // the order of the buyer (two products, 10 and 20), its payment, its statement and the rows of
  // the statement for each product
  orderId: number;
  paymentId: string;
  paidAt: string;
  returnId: number;
  firstRow: number;
  secondRow: number;
  first: { id: number; variantId: number };
  // the keys of the two transfers and the ids the provider gave them
  firstKey: string;
  secondKey: string;
  refundOk: string;
  refundFailed: string;
  // the two orders of the other buyer: one with a refund made by hand (15, 5 back), one with a
  // dispute (8, all of it taken)
  handOrderId: number;
  handPaymentId: string;
  handRefundId: string;
  disputeOrderId: number;
  disputePaymentId: string;
  disputeId: number;
  disputeTxId: string;
};
let story: Story;

type Line = Record<string, any>;
type Page = { items: Line[]; total: number; limit: number; nextCursor: string | null };

const read = (query: string, actor: TestUser = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/money-log?${query}`,
    headers: { cookie: accessCookie(actor) },
  });

async function pageOf(query: string, actor: TestUser = admin): Promise<Page> {
  const res = await read(query, actor);
  expect(res.statusCode).toBe(200);
  return res.json() as Page;
}

// every line of a list in one page, or walking it a few lines at a time
const all = (query: string, actor?: TestUser) => pageOf(`${query}&limit=100`, actor);

async function walk(query: string, size: number, actor?: TestUser): Promise<Line[]> {
  const seen: Line[] = [];
  let cursor: string | null = null;
  do {
    const page: Page = await pageOf(
      `${query}&limit=${size}${cursor ? `&cursor=${cursor}` : ''}`,
      actor,
    );
    expect(page.items.length).toBeLessThanOrEqual(size);
    seen.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  return seen;
}

// a call of the database as the actor of the request it stands for: an admin or root signed in
// (with the address and the browser of the request), or the system (the webhook, the worker)
async function as<T>(
  who: TestUser | null,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  request: { ip: string; userAgent: string } | null = null,
): Promise<T> {
  return testTx(async (tx) => {
    if (who) await setUserContext(tx, { userId: who.id, role: who.role });
    else await setAdminContext(tx);
    if (request) {
      await tx.$executeRaw`select set_config('cartlify.request_ip', ${request.ip}, true),
        set_config('cartlify.request_user_agent', ${request.userAgent}, true)`;
    }
    return fn(tx);
  });
}

const ADMIN_REQUEST = { ip: ADMIN_IP, userAgent: AGENT };
const ROOT_REQUEST = { ip: ROOT_IP, userAgent: ROOT_AGENT };

type Answer = { result: Record<string, unknown> }[];

// an admin starts the transfer of one row of the statement: the key of the request it answers
async function transferOf(returnId: number, rowId: number): Promise<string> {
  const [answer] = await as(
    admin,
    (tx) => tx.$queryRaw<Answer>`
      select cartlify.begin_return_refund(${returnId}::int, ${[rowId]}::int[], null::jsonb) as result`,
    ADMIN_REQUEST,
  );
  return answer!.result.key as string;
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
  cashier = await newUser({ role: 'ADMIN' });
  await giveMoneyRight(root.id, cashier.id);
  buyer = await newUser();
  otherBuyer = await newUser();

  const first = await createProduct({ price: 10, stock: 5 });
  const second = await createProduct({ price: 20, stock: 5 });
  const handProduct = await createProduct({ price: 15, stock: 5 });
  const disputeProduct = await createProduct({ price: 8, stock: 5 });

  // the buyer pays an order of the two products: the system writes the payment
  const paid = await placePaidOrderOf(app, csrf, buyer, [
    { item: first, quantity: 1 },
    { item: second, quantity: 1 },
  ]);
  const { paidAt } = await asAdmin((tx) =>
    tx.order.findUniqueOrThrow({ where: { id: paid.orderId }, select: { paidAt: true } }),
  );

  // the admin cancels it: a statement of the shop for every unit, the money due at once
  const [cancelled] = await as(
    admin,
    (tx) => tx.$queryRaw<{ id: number }[]>`
      select cartlify.create_return(
        ${paid.orderId}::int,
        (select jsonb_agg(jsonb_build_object('orderItemId', i.id, 'quantity', i.quantity) order by i.id)
         from cartlify.order_items as i where i."orderId" = ${paid.orderId}::int),
        'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
        'shop_cancel'::cartlify."ReturnReason", null, 'Test Buyer', 'buyer@example.com', null,
        null, 4, 'Europe/Madrid'
      ) as id`,
    ADMIN_REQUEST,
  );
  const returnId = cancelled!.id;
  const rows = await asAdmin((tx) =>
    tx.orderReturnItem.findMany({
      where: { returnId },
      select: { id: true, orderItem: { select: { variantId: true } } },
    }),
  );
  const rowOf = (variantId: number) =>
    rows.find((row) => row.orderItem.variantId === variantId)!.id;
  const firstRow = rowOf(first.variantId);
  const secondRow = rowOf(second.variantId);

  // the first transfer goes: the provider tells it sent
  const firstKey = await transferOf(returnId, firstRow);
  const refundOk = `re_mlog_ok_${randomUUID()}`;
  await as(
    null,
    (tx) => tx.$queryRaw`
      select cartlify.settle_money_refund(${firstKey}, ${refundOk}, 'succeeded',
        null::cartlify."RefundFailure", null) as result`,
  );

  // the second fails at the provider, and root sends that money outside the app
  const secondKey = await transferOf(returnId, secondRow);
  const refundFailed = `re_mlog_fail_${randomUUID()}`;
  await as(
    null,
    (tx) => tx.$queryRaw`
      select cartlify.settle_money_refund(${secondKey}, ${refundFailed}, 'failed',
        'card_unavailable'::cartlify."RefundFailure", ${FAILURE_TEXT}) as result`,
  );
  await as(
    root,
    (tx) => tx.$queryRaw`
      select cartlify.mark_return_refunded_outside(${returnId}::int, ${[secondRow]}::int[],
        'bank_transfer'::cartlify."OutsideMethod", ${NOTE}, ${paidAt!.toISOString()}::timestamp
      ) as result`,
    ROOT_REQUEST,
  );

  // the other buyer pays two orders: the dashboard of the provider sends 5 of the first back by
  // hand, the bank takes all of the second for a dispute
  const hand = await placePaidOrderOf(app, csrf, otherBuyer, [{ item: handProduct, quantity: 1 }]);
  const handRefundId = `re_mlog_hand_${randomUUID()}`;
  await as(
    null,
    (tx) => tx.$queryRaw`
      select cartlify.record_hand_refund('stripe'::cartlify."PaymentProvider", ${hand.paymentId},
        ${handRefundId}, 5::numeric, 'pending', 'eur') as result`,
  );

  const disputed = await placePaidOrderOf(app, csrf, otherBuyer, [
    { item: disputeProduct, quantity: 1 },
  ]);
  const disputeTxId = `txn_mlog_${randomUUID()}`;
  const [synced] = await as(
    null,
    (tx) => tx.$queryRaw<Answer>`
      select cartlify.sync_payment_dispute('stripe'::cartlify."PaymentProvider",
        ${`dp_mlog_${randomUUID()}`}, ${disputed.paymentId},
        'needs_response'::cartlify."DisputeStatus", 'fraudulent', '2026-12-01 23:59:59'::timestamp,
        false, 0::int, false, '2026-11-01 10:00:00'::timestamp, null::timestamp,
        ${JSON.stringify([{ id: disputeTxId, amount: -8, fee: 15, currency: 'eur' }])}::jsonb
      ) as result`,
  );

  story = {
    orderId: paid.orderId,
    paymentId: paid.paymentId,
    paidAt: paidAt!.toISOString(),
    returnId,
    firstRow,
    secondRow,
    first: { id: first.id, variantId: first.variantId },
    firstKey,
    secondKey,
    refundOk,
    refundFailed,
    handOrderId: hand.orderId,
    handPaymentId: hand.paymentId,
    handRefundId,
    disputeOrderId: disputed.orderId,
    disputePaymentId: disputed.paymentId,
    disputeId: synced!.result.id as number,
    disputeTxId,
  };
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// the lines of the buyer: the payment, the two transfers, the failure of the second, the money
// root sent outside the app
const mine = () => `userId=${buyer.id}`;
// the lines of the other buyer: two payments, the refund by hand, what the bank took
const theirs = () => `userId=${otherBuyer.id}`;

const SORTS = [
  'id',
  'createdAt',
  'actorId',
  'actorRole',
  'event',
  'purpose',
  'part',
  'amount',
  'currency',
  'orderId',
  'userId',
  'returnId',
  'orderShipmentId',
  'disputeId',
  'coversId',
  'provider',
  'paymentId',
  'refundId',
  'transferKey',
  'stripeTxId',
  'bankReference',
  'byDashboard',
  'state',
  'stateAt',
  'failure',
  'failureText',
  'method',
  'note',
  'happenedAt',
  'moneyUse',
  'ip',
  'userAgent',
];

const COLUMNS = [
  'id',
  'createdAt',
  'actorId',
  'actor',
  'actorRole',
  'event',
  'purpose',
  'part',
  'amount',
  'currency',
  'orderId',
  'userId',
  'user',
  'returnId',
  'orderShipmentId',
  'disputeId',
  'coversId',
  'provider',
  'paymentId',
  'refundId',
  'transferKey',
  'stripeTxId',
  'bankReference',
  'byDashboard',
  'state',
  'stateAt',
  'failure',
  'failureText',
  'method',
  'note',
  'happenedAt',
  'moneyUse',
  'ip',
  'userAgent',
  'meta',
];

const CSV_HEADER = (columns: string[]) =>
  columns
    .flatMap((column) => {
      if (column === 'actor') return ['actorName', 'actorEmail'];
      if (column === 'user') return ['userName', 'userEmail'];
      return [column];
    })
    .join(',');

const csvLines = (body: string) =>
  body
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n');

const comparable = (value: unknown) =>
  value === null || value === undefined ? null : typeof value === 'number' ? value : String(value);

// the lines are in the order of the column, the lines without a value last, whichever way it goes
function expectSorted(items: Line[], column: string, order: 'asc' | 'desc') {
  const values = items.map((item) => comparable(item[column]));
  const present = values.filter((value) => value !== null);
  const firstNull = values.indexOf(null);
  if (firstNull >= 0) expect(values.slice(firstNull).every((value) => value === null)).toBe(true);

  const ordered = [...present].sort((x, y) => (x! < y! ? -1 : x! > y! ? 1 : 0));
  if (order === 'desc') ordered.reverse();
  expect(present).toEqual(ordered);
}

describe('GET /api/admin/money-log', () => {
  it('gives every column of every line of a buyer, the newest first', async () => {
    const page = await all(mine());

    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(5);
    for (const item of page.items) expect(Object.keys(item).sort()).toEqual([...COLUMNS].sort());
    expectSorted(page.items, 'id', 'desc');
    expect(page.items.map((item) => item.event)).toEqual([
      'money.outside',
      'money.refund_failed',
      'money.refund',
      'money.refund',
      'money.payment',
    ]);
  });

  it('describes the payment of an order: the work of the system, the goods, the payment at the provider, the buyer', async () => {
    const page = await all(`orderId=${story.orderId}&events=money.payment`);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      actorId: null,
      actor: null,
      actorRole: null,
      event: 'money.payment',
      purpose: 'order',
      part: 'goods',
      // the sum is a number of the money, above 0 to the shop
      amount: 30,
      orderId: story.orderId,
      userId: buyer.id,
      user: { id: buyer.id, email: buyer.email, role: 'USER', deleted: false },
      returnId: null,
      provider: 'stripe',
      paymentId: story.paymentId,
      refundId: null,
      transferKey: null,
      state: null,
      stateAt: null,
      ip: null,
      userAgent: null,
      meta: [],
    });
  });

  it('describes a transfer of a statement: the admin, the key of the request, the rows it pays, sent with the id of the refund', async () => {
    const page = await all(`returnId=${story.returnId}&events=money.refund&sortOrder=asc`);

    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      actorId: admin.id,
      actor: { id: admin.id, email: admin.email, role: 'ADMIN' },
      actorRole: 'ADMIN',
      event: 'money.refund',
      purpose: 'return',
      part: 'goods',
      amount: -10,
      orderId: story.orderId,
      userId: buyer.id,
      returnId: story.returnId,
      provider: 'stripe',
      paymentId: story.paymentId,
      refundId: story.refundOk,
      transferKey: story.firstKey,
      byDashboard: false,
      state: 'sent',
      stateAt: expect.any(String),
      failure: null,
      coversId: null,
      ip: ADMIN_IP,
      userAgent: AGENT,
    });
    expect(page.items[0]!.meta).toEqual([
      expect.objectContaining({
        returnItemId: story.firstRow,
        variantId: story.first.variantId,
        amount: 10,
      }),
    ]);
    // the second stays in transit: the provider never sent it, the line names the refund that failed
    expect(page.items[1]).toMatchObject({
      amount: -20,
      transferKey: story.secondKey,
      refundId: story.refundFailed,
      state: 'in_transit',
    });
  });

  it('describes a failed transfer: a new line of the system with the opposite sum, the line it reverses, the reason', async () => {
    const failed = await all(`returnId=${story.returnId}&events=money.refund_failed`);
    const second = (await all(`returnId=${story.returnId}&events=money.refund&state=in_transit`))
      .items[0]!;

    expect(failed.items).toHaveLength(1);
    expect(failed.items[0]).toMatchObject({
      actorId: null,
      actor: null,
      event: 'money.refund_failed',
      purpose: 'return',
      part: 'goods',
      amount: 20,
      coversId: second.id,
      failure: 'card_unavailable',
      failureText: FAILURE_TEXT,
      refundId: story.refundFailed,
      transferKey: story.secondKey,
      state: null,
    });
  });

  // root reads its own line as it is; what an admin sees of it is in "who reads it"
  it('describes the money root sent outside the app: the way, the note, the day it happened', async () => {
    const page = await all(`returnId=${story.returnId}&events=money.outside`, root);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      actorId: root.id,
      actor: { id: root.id, email: root.email, role: 'ROOT' },
      actorRole: 'ROOT',
      event: 'money.outside',
      purpose: 'return',
      part: 'goods',
      amount: -20,
      method: 'bank_transfer',
      note: NOTE,
      happenedAt: story.paidAt,
      transferKey: null,
      refundId: null,
      state: null,
      ip: ROOT_IP,
      userAgent: ROOT_AGENT,
    });
  });

  it('describes a refund made by hand in the dashboard and what the bank took for a dispute', async () => {
    const hand = await all(`${theirs()}&purpose=hand`);
    const dispute = await all(`${theirs()}&purpose=dispute`);

    expect(hand.items).toHaveLength(1);
    expect(hand.items[0]).toMatchObject({
      actorId: null,
      event: 'money.refund',
      purpose: 'hand',
      part: 'whole',
      amount: -5,
      currency: 'eur',
      orderId: story.handOrderId,
      paymentId: story.handPaymentId,
      refundId: story.handRefundId,
      byDashboard: true,
      state: 'in_transit',
      transferKey: null,
    });
    expect(dispute.items).toHaveLength(1);
    expect(dispute.items[0]).toMatchObject({
      actorId: null,
      event: 'money.dispute_withdrawn',
      purpose: 'dispute',
      part: 'whole',
      // without the fee of the provider
      amount: -8,
      currency: 'eur',
      orderId: story.disputeOrderId,
      paymentId: story.disputePaymentId,
      disputeId: story.disputeId,
      stripeTxId: story.disputeTxId,
      state: null,
    });
  });

  describe('the filters', () => {
    const eventsOf = (page: Page) => page.items.map((item) => item.event).sort();

    it('keeps the lines of an order', async () => {
      const order = await all(`orderId=${story.orderId}`);
      const hand = await all(`orderId=${story.handOrderId}`);

      expect(order.total).toBe(5);
      expect(eventsOf(hand)).toEqual(['money.payment', 'money.refund']);
    });

    it('keeps the lines of a buyer, whatever order', async () => {
      const page = await all(theirs());

      expect(page.total).toBe(4);
      expect(new Set(page.items.map((item) => item.orderId))).toEqual(
        new Set([story.handOrderId, story.disputeOrderId]),
      );
    });

    it('keeps the lines of a statement: its transfers, their failure, the money outside the app', async () => {
      const page = await all(`returnId=${story.returnId}`);

      expect(eventsOf(page)).toEqual([
        'money.outside',
        'money.refund',
        'money.refund',
        'money.refund_failed',
      ]);
    });

    it('keeps the lines of a dispute', async () => {
      const page = await all(`disputeId=${story.disputeId}`);

      expect(page.items.map((item) => item.stripeTxId)).toEqual([story.disputeTxId]);
    });

    it('keeps the lines of a payment at the provider', async () => {
      const page = await all(`paymentId=${story.handPaymentId}`);

      expect(page.total).toBe(2);
      expect(page.items.every((item) => item.orderId === story.handOrderId)).toBe(true);
    });

    it('keeps the lines of a purpose', async () => {
      const returns = await all(`${mine()}&purpose=return`);
      const orders = await all(`${mine()}&purpose=order`);

      expect(returns.total).toBe(4);
      expect(orders.items.map((item) => item.event)).toEqual(['money.payment']);
    });

    it('keeps the refunds where they stand: in transit or sent', async () => {
      const inTransit = await all(`${mine()}&state=in_transit`);
      const sent = await all(`${mine()}&state=sent`);
      const handInTransit = await all(`${theirs()}&state=in_transit`);

      expect(inTransit.items.map((item) => item.transferKey)).toEqual([story.secondKey]);
      expect(sent.items.map((item) => item.refundId)).toEqual([story.refundOk]);
      expect(handInTransit.items.map((item) => item.refundId)).toEqual([story.handRefundId]);
    });

    it('combines the filters: all of them have to hold', async () => {
      const refundsOfOrder = await all(`orderId=${story.orderId}&events=money.refund`);
      const waitingOfStatement = await all(`returnId=${story.returnId}&state=in_transit`);
      const disputeOfOrder = await all(`orderId=${story.orderId}&disputeId=${story.disputeId}`);
      const otherPayment = await all(`${theirs()}&paymentId=${story.paymentId}`);
      const disputeOfBuyer = await all(`${theirs()}&purpose=dispute`);
      const inPeriod = await all(
        `${mine()}&from=${new Date(Date.now() - 3_600_000).toISOString()}`,
      );

      expect(refundsOfOrder.total).toBe(2);
      expect(waitingOfStatement.total).toBe(1);
      expect(disputeOfOrder.total).toBe(0);
      expect(otherPayment.total).toBe(0);
      expect(disputeOfBuyer.total).toBe(1);
      expect(inPeriod.total).toBe(5);
    });

    it('finds no line of a payment that is not there', async () => {
      const page = await all(`paymentId=pi_mlog_nothing_${randomUUID()}`);

      expect(page).toMatchObject({ total: 0, items: [], nextCursor: null });
    });
  });

  describe('the validation', () => {
    it.each([
      'orderId=0',
      'orderId=-1',
      'orderId=abc',
      'orderId=1.5',
      'orderId=2147483648',
      'userId=0',
      'userId=x',
      'userId=2147483648',
      'returnId=0',
      'returnId=2147483648',
      'disputeId=0',
      'disputeId=abc',
      'paymentId=',
      `paymentId=${'p'.repeat(256)}`,
      'purpose=refund',
      'purpose=ORDER',
      'state=failed',
      'state=sent,in_transit',
      'limit=0',
      'limit=101',
      'sortBy=meta',
      'sortBy=actor',
      'sortBy=user',
      'sortOrder=sideways',
      'format=xml',
      'from=yesterday',
    ])('refuses the query %s', async (query) => {
      const res = await read(query);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    });

    it('refuses a column or an event the journal has not, and names what it has', async () => {
      const column = await read('columns=id,secret');
      const event = await read('events=money.refund,money.nothing');
      const other = await read('events=stock.sale');
      const old = await read('events=legacy.unknown');

      expect(column.statusCode).toBe(400);
      expect(column.json()).toMatchObject({
        errorCode: 'LOG_COLUMNS_INVALID',
        details: { columns: ['secret'], allowed: COLUMNS },
      });
      expect(event.statusCode).toBe(400);
      expect(event.json()).toMatchObject({
        errorCode: 'LOG_EVENTS_INVALID',
        details: { events: ['money.nothing'], allowed: [...MONEY_LOG_EVENTS] },
      });
      // an event of another journal is not one of this
      expect(other.statusCode).toBe(400);
      expect(other.json()).toMatchObject({ errorCode: 'LOG_EVENTS_INVALID' });
      // the money log began with its events: no line has the event of an old line
      expect(old.statusCode).toBe(400);
      expect(old.json()).toMatchObject({ errorCode: 'LOG_EVENTS_INVALID' });
    });

    it('refuses a period that ends before it starts', async () => {
      const res = await read('from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z');

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'INVALID_STATS_PERIOD' });
    });

    it('refuses a cursor made for another sort', async () => {
      const first = await pageOf(`${mine()}&limit=1&sortBy=amount`);

      const res = await read(`${mine()}&limit=1&sortBy=id&cursor=${first.nextCursor}`);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    });
  });

  describe('the sorts', () => {
    // root reads the values as they are, so the order of the values can be checked; an admin gets
    // the same lines in the same order, with the data of root hidden (see "who reads it")
    // one test a column: every column walks its pages both ways for root and for an admin
    it.each(SORTS)(
      'sorts by %s both ways, and the cursor walks the lines in the same order',
      async (sortBy) => {
        for (const sortOrder of ['asc', 'desc'] as const) {
          const query = `${mine()}&sortBy=${sortBy}&sortOrder=${sortOrder}`;

          const whole = await all(query, root);
          const walked = await walk(query, 2, root);
          const walkedByAdmin = await walk(query, 2);

          expect(whole.items).toHaveLength(5);
          expectSorted(whole.items, sortBy, sortOrder);
          // the same lines in the same order, page by page, none twice and none missed
          expect(walked.map((item) => item.id)).toEqual(whole.items.map((item) => item.id));
          expect(walkedByAdmin.map((item) => item.id)).toEqual(whole.items.map((item) => item.id));
        }
      },
    );

    it('puts the lines without a value last whichever way the column goes', async () => {
      for (const sortOrder of ['asc', 'desc'] as const) {
        const page = await all(`${mine()}&sortBy=refundId&sortOrder=${sortOrder}`);

        // the payment and the money outside have no refund of the provider
        expect(page.items.map((item) => item.refundId === null)).toEqual([
          false,
          false,
          false,
          true,
          true,
        ]);
        const ids = page.items.slice(3).map((item) => item.id as number);
        expect(ids).toEqual([...ids].sort((x, y) => (sortOrder === 'asc' ? x - y : y - x)));
      }
    });

    it('sorts by the sum: the money that went out first, the largest that came in last', async () => {
      const page = await all(`${mine()}&sortBy=amount&sortOrder=asc`);

      expect(page.items.map((item) => item.amount)).toEqual([-20, -20, -10, 20, 30]);
    });
  });

  describe('the events, the columns and the period', () => {
    it('keeps the lines of the events asked for and counts only them', async () => {
      const some = await all(`${mine()}&events=money.refund,money.refund_failed`);
      const one = await all(`${mine()}&events=money.outside`);

      expect(some.total).toBe(3);
      expect(some.items.map((item) => item.event).sort()).toEqual([
        'money.refund',
        'money.refund',
        'money.refund_failed',
      ]);
      expect(one.total).toBe(1);
    });

    it('gives the columns asked for, in the page and in the csv', async () => {
      const page = await all(`${mine()}&columns=state,amount,id`);
      const csv = await read(`${mine()}&columns=state,amount,id&format=csv`);

      for (const item of page.items) {
        expect(Object.keys(item).sort()).toEqual(['amount', 'id', 'state']);
      }
      const lines = csvLines(csv.body);
      // the order of the journal, not the order of the request
      expect(lines[0]).toBe('id,amount,state');
      expect(lines).toHaveLength(6);
    });

    it('reads a period: from taken in, to left out', async () => {
      const now = Date.now();
      const day = 86_400_000;

      const inside = await all(
        `${mine()}&from=${new Date(now - 2 * day).toISOString()}&to=${new Date(now + day).toISOString()}`,
      );
      const before = await all(`${mine()}&to=${new Date(now - 2 * day).toISOString()}`);
      const after = await all(`${mine()}&from=${new Date(now + 2 * day).toISOString()}`);
      // a period that starts at the time of a line takes it in and ends where it is left out
      const at = (await all(`${mine()}&sortOrder=asc`)).items[0]!.createdAt as string;
      const fromIt = await all(`${mine()}&from=${at}`);
      const toIt = await all(`${mine()}&to=${at}`);

      expect(inside.total).toBe(5);
      expect(before.total).toBe(0);
      expect(after.total).toBe(0);
      expect(fromIt.total).toBe(5);
      expect(toIt.total).toBe(0);
    });
  });

  describe('the csv', () => {
    it('gives every line of the filters with the header of all the columns', async () => {
      const csv = await read(`${mine()}&format=csv&sortBy=event`);

      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toContain('cartlify-money-log-');
      const lines = csvLines(csv.body);
      expect(lines[0]).toBe(CSV_HEADER(COLUMNS));
      expect(lines).toHaveLength(6);
      // no page: every line comes, whatever the limit
      const limited = await read(`${mine()}&format=csv&limit=2`);
      expect(csvLines(limited.body)).toHaveLength(6);
    });

    it('writes the sums to the cent, with their sign, and the state of a refund', async () => {
      const csv = await read(
        `orderId=${story.orderId}&events=money.refund&format=csv&columns=amount,event,state,actorRole,refundId`,
      );

      expect(csvLines(csv.body)).toEqual([
        'actorRole,event,amount,refundId,state',
        `ADMIN,money.refund,-20.00,${story.refundFailed},in_transit`,
        `ADMIN,money.refund,-10.00,${story.refundOk},sent`,
      ]);
    });
  });

  describe('who reads it', () => {
    it('lets root read the same lines as an admin, the same filters', async () => {
      const seenByAdmin = await all(mine());
      const seenByRoot = await all(mine(), root);

      expect(seenByRoot.total).toBe(seenByAdmin.total);
      expect(seenByRoot.items.map((item) => item.id)).toEqual(
        seenByAdmin.items.map((item) => item.id),
      );
    });

    // the database lets a buyer read the lines of their own money; the journal of the shop is not
    // the place a buyer reads them
    it('refuses a customer, even for the lines of their own money', async () => {
      const res = await read(mine(), buyer);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    });

    it('refuses a visitor who is not signed in', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/admin/money-log?${mine()}` });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    });

    it('hides who root is from an admin and shows it to root, the lines and the filters the same', async () => {
      const query = `returnId=${story.returnId}&events=money.outside`;

      const seenByAdmin = (await all(query)).items[0]!;
      const seenByRoot = (await all(query, root)).items[0]!;

      expect(seenByAdmin).toMatchObject({
        actorId: 0,
        actor: { id: 0, email: 'hidden', role: 'ROOT' },
        // the role stays: it is no secret who did it as root, only who root is
        actorRole: 'ROOT',
        ip: 'hidden',
        userAgent: 'hidden',
        // what the line says of the money is the shop's, not root's
        event: 'money.outside',
        amount: -20,
        method: 'bank_transfer',
        note: NOTE,
      });
      expect([null, 'hidden']).toContain(seenByAdmin.actor.name);
      expect(seenByRoot).toMatchObject({
        actorId: root.id,
        actor: { id: root.id, email: root.email, role: 'ROOT' },
        ip: ROOT_IP,
        userAgent: ROOT_AGENT,
      });
      // the same fields for both: only the values differ
      expect(Object.keys(seenByAdmin).sort()).toEqual(Object.keys(seenByRoot).sort());
      // an admin finds the lines of root by the account too, the sort is no secret
      const sorted = await all(`${mine()}&sortBy=actorId&sortOrder=asc`);
      expect(sorted.total).toBe(5);
    });

    // going up, the line of root is the first of the address and of the browser: the cursor of the
    // first page ends at it
    it('does not carry the value of a line of root in the cursor an admin is given', async () => {
      for (const sortBy of ['ip', 'userAgent']) {
        const page = await pageOf(`${mine()}&sortBy=${sortBy}&sortOrder=asc&limit=1`);

        expect(page.items[0]).toMatchObject({ actorRole: 'ROOT', ip: 'hidden' });
        const decoded = Buffer.from(page.nextCursor!, 'base64url').toString('utf8');
        expect(decoded).not.toContain(ROOT_AGENT);
        expect(decoded).not.toContain(ROOT_IP);
      }
    });
  });
});

// one filter for every other column, the sums of the filters, the groups (the journals for the
// analysis)
describe('GET /api/admin/money-log by every column', () => {
  // the lines of both buyers of the story, as root reads them
  const storyLines = async () => [
    ...(await all(mine(), root)).items,
    ...(await all(theirs(), root)).items,
  ];
  const idsOf = (lines: Line[]) => lines.map((line) => line.id as number).sort((a, b) => a - b);
  const keptBy = async (filter: string, actor: TestUser = root) =>
    idsOf([
      ...(await all(`${mine()}&${filter}`, actor)).items,
      ...(await all(`${theirs()}&${filter}`, actor)).items,
    ]);

  it.each<[string, (line: Line) => boolean]>([
    ['part=goods', (line) => line.part === 'goods'],
    ['amountFrom=0.01', (line) => line.amount >= 0.01],
    ['amountTo=-0.01', (line) => line.amount <= -0.01],
    ['amountFrom=-20&amountTo=-20', (line) => line.amount === -20],
    ['currency=eur', (line) => line.currency === 'eur'],
    ['provider=stripe', (line) => line.provider === 'stripe'],
    ['failure=card_unavailable', (line) => line.failure === 'card_unavailable'],
    ['method=bank_transfer', (line) => line.method === 'bank_transfer'],
    [
      'note=BANK%20transfer',
      (line) =>
        String(line.note ?? '')
          .toLowerCase()
          .includes('bank transfer'),
    ],
    ['byDashboard=false', (line) => line.byDashboard === false],
    ['actorRole=ADMIN', (line) => line.actorRole === 'ADMIN'],
    [`ip=${ADMIN_IP}`, (line) => line.ip === ADMIN_IP],
    [
      'userAgent=ROOT%20BROWSER',
      (line) =>
        String(line.userAgent ?? '')
          .toLowerCase()
          .includes('root browser'),
    ],
  ])('keeps the lines of %s and every one of them', async (filter, keeps) => {
    const expected = idsOf((await storyLines()).filter(keeps));

    expect(expected.length).toBeGreaterThan(0);
    expect(await keptBy(filter)).toEqual(expected);
  });

  // an admin sees the lines of root in the lists and the sorts, but cannot pick them out by who did
  // them; an admin root allowed to handle the money may, in this journal only, root still hidden
  it('lets no admin pick the lines of root by who did them, but one with the right of the money', async () => {
    const ofRoot = idsOf((await storyLines()).filter((line) => line.actorId === root.id));
    expect(ofRoot.length).toBeGreaterThan(0);

    for (const filter of [`actorId=${root.id}`, 'actorRole=ROOT']) {
      expect(await keptBy(filter, admin)).toEqual([]);
      expect(await keptBy(filter, cashier)).toEqual(ofRoot);
    }
    const [picked] = (await all(`${mine()}&actorId=${root.id}`, cashier)).items;
    expect(picked).toMatchObject({
      actorId: 0,
      actor: expect.objectContaining({ email: 'hidden' }),
    });
  });

  // a buyer whose account is root's now: the filter of the buyer picks none of their lines for an
  // admin, but for one with the right of the money, who the buyer is still hidden
  it('lets no admin pick the lines of a buyer who is root now by the buyer, but one with the right of the money', async () => {
    const later = await newUser();
    const product = await createProduct({ price: 10, stock: 5 });
    await placePaidOrderOf(app, csrf, later, [{ item: product, quantity: 1 }]);
    await testTx(async (tx) => {
      await setUserContext(tx, { userId: later.id, role: 'ROOT' });
      await tx.user.update({ where: { id: later.id }, data: { role: 'ROOT' } });
    });
    const byBuyer = (actor: TestUser) => all(`userId=${later.id}`, actor);

    const forRoot = (await byBuyer(root)).items;
    expect(forRoot.length).toBeGreaterThan(0);
    expect((await byBuyer(admin)).items).toEqual([]);
    const forCashier = (await byBuyer(cashier)).items;
    expect(forCashier.map((line) => line.id)).toEqual(forRoot.map((line) => line.id));
    expect(forCashier[0]).toMatchObject({
      userId: 0,
      user: expect.objectContaining({ email: 'hidden' }),
    });
  });

  it('keeps the lines of an id of the provider or of the app, and the line a line names', async () => {
    const lines = await storyLines();
    const failed = lines.find((line) => line.event === 'money.refund_failed')!;
    const withKey = lines.filter((line) => line.transferKey === story.firstKey);

    expect(await keptBy(`refundId=${story.refundOk}`)).toEqual(
      idsOf(lines.filter((line) => line.refundId === story.refundOk)),
    );
    expect(await keptBy(`transferKey=${encodeURIComponent(story.firstKey)}`)).toEqual(
      idsOf(withKey),
    );
    expect(await keptBy(`stripeTxId=${story.disputeTxId}`)).toHaveLength(1);
    expect(await keptBy(`coversId=${failed.coversId}`)).toEqual(
      idsOf(lines.filter((line) => line.coversId === failed.coversId)),
    );
    expect(await keptBy(`actorId=${root.id}`)).toEqual(
      idsOf(lines.filter((line) => line.actorId === root.id)),
    );
    expect(await keptBy('orderShipmentId=1')).toEqual([]);
  });

  it('keeps the money that really moved within a time, and the refunds by the time of their state', async () => {
    const lines = await storyLines();
    const after = new Date(new Date(story.paidAt).getTime() + 1).toISOString();

    expect(await keptBy(`happenedFrom=${story.paidAt}&happenedTo=${after}`)).toEqual(
      idsOf(lines.filter((line) => line.happenedAt === story.paidAt)),
    );
    expect(await keptBy(`stateFrom=${new Date(Date.now() - 3_600_000).toISOString()}`)).toEqual(
      idsOf(lines.filter((line) => line.stateAt !== null)),
    );
  });

  it('never finds the lines of root by its address or browser for an admin', async () => {
    expect(await keptBy(`ip=${ROOT_IP}`, admin)).toEqual([]);
    expect(await keptBy('userAgent=root%20browser', admin)).toEqual([]);
    expect((await keptBy(`ip=${ROOT_IP}`, root)).length).toBeGreaterThan(0);
  });

  it('gives the sums of every line of the filters, a sum for each currency, whatever the page', async () => {
    const lines = (await all(mine())).items;
    const byCurrency = new Map<string | null, number>();
    for (const line of lines) {
      byCurrency.set(
        line.currency,
        (byCurrency.get(line.currency) ?? 0) + Math.round(line.amount * 100),
      );
    }

    const page = await pageOf(`${mine()}&limit=1`);

    expect(page.items).toHaveLength(1);
    expect((page as Page & { sums: unknown }).sums).toEqual(
      [...byCurrency.entries()]
        .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
        .map(([currency, cents]) => ({ currency, amount: cents / 100 })),
    );
  });

  it.each([
    'amountFrom=abc',
    'amountTo=100000000',
    'part=part',
    'provider=paypal_old',
    'failure=lost',
    'method=cheque',
    'moneyUse=gift',
    'byDashboard=maybe',
    'happenedFrom=yesterday',
    'actorRole=GUEST',
    'actorId=0',
    'ip=',
  ])('refuses the query %s', async (query) => {
    const res = await read(query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('GET /api/admin/money-log/groups', () => {
  type Group = Record<string, any> & { count: number; amount: number };
  type Groups = { items: Group[]; total: number; limit: number; offset: number };
  const groups = (query: string, actor: TestUser = admin) =>
    app.inject({
      method: 'GET',
      url: `/api/admin/money-log/groups?${query}`,
      headers: { cookie: accessCookie(actor) },
    });
  const groupsOf = async (query: string, actor: TestUser = admin) => {
    const res = await groups(query, actor);
    expect(res.statusCode).toBe(200);
    return res.json() as Groups;
  };

  it('takes the lines of the filters together by a key, with their count and their sum', async () => {
    const lines = (await all(mine())).items;
    const expected = new Map<string, { count: number; cents: number }>();
    for (const line of lines) {
      const group = expected.get(line.event) ?? { count: 0, cents: 0 };
      group.count += 1;
      group.cents += Math.round(line.amount * 100);
      expected.set(line.event, group);
    }

    const out = await groupsOf(`${mine()}&groupBy=event&sortBy=event&sortOrder=asc`);

    expect(out.total).toBe(expected.size);
    expect(out.items).toEqual(
      [...expected.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([event, group]) => ({ event, count: group.count, amount: group.cents / 100 })),
    );
  });

  it('takes them together by several keys and pages the groups by an offset', async () => {
    const every = await groupsOf(`${mine()}&groupBy=purpose,event,month&limit=100`);
    const second = await groupsOf(`${mine()}&groupBy=purpose,event,month&limit=1&offset=1`);

    expect(every.items.reduce((sum, group) => sum + group.count, 0)).toBe(
      (await all(mine())).total,
    );
    expect(every.items[0]).toEqual(
      expect.objectContaining({
        purpose: expect.any(String),
        month: expect.stringMatching(/^\d{4}-\d{2}$/),
      }),
    );
    expect(second).toMatchObject({ total: every.total, limit: 1, offset: 1 });
    expect(second.items).toEqual([every.items[1]]);
  });

  it('keeps root one group of the hidden id for an admin, and itself for root', async () => {
    const forAdmin = await groupsOf(`${mine()}&groupBy=actorId`);
    const forRoot = await groupsOf(`${mine()}&groupBy=actorId`, root);

    expect(forAdmin.items.map((group) => group.actorId)).toContain(0);
    expect(forAdmin.items.map((group) => group.actorId)).not.toContain(root.id);
    expect(forRoot.items.map((group) => group.actorId)).toContain(root.id);
  });

  it('gives every group as a csv file', async () => {
    const res = await groups(`${mine()}&groupBy=event&format=csv`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.split('\r\n')[0]).toBe('﻿event,count,amount');
  });

  // the sorts of the groups are their own: the count and a key of time are no sorts of the journal
  it('sorts the groups by their count and by a key they group by', async () => {
    const byCount = await groupsOf(`${mine()}&groupBy=event&sortBy=count&sortOrder=asc`);
    const byMonth = await groupsOf(`${mine()}&groupBy=month,event&sortBy=month&sortOrder=asc`);

    const counts = byCount.items.map((group) => group.count);
    expect(counts.length).toBeGreaterThan(1);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    const months = byMonth.items.map((group) => group.month as string);
    expect(months).toEqual([...months].sort());
  });

  it('refuses a sort by a key it does not group by', async () => {
    const res = await groups('groupBy=event&sortBy=month');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'LOG_SORT_INVALID' });
  });

  it.each([
    '',
    'groupBy=',
    'groupBy=amount',
    'groupBy=event,purpose,part,currency',
    'groupBy=event&limit=1001',
    'groupBy=event&offset=-1',
  ])('refuses the query %s', async (query) => {
    const res = await groups(query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a customer', async () => {
    const res = await groups('groupBy=event', buyer);

    expect(res.statusCode).toBe(403);
  });
});

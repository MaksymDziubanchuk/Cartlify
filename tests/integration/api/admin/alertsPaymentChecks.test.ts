import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { alertsOf } from '../../../helpers/alerts.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { moveClock, placePaidOrder } from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  craftEvent,
  deliver,
  earlyFraudWarningOf,
  paymentReviewOf,
} from '../../../helpers/stripe.js';

// The alerts of root of the checks of a payment the provider asks for (GET /api/admin/alerts): fraud_warnings counts the
// orders not sent an early warning of fraud holds until root decides (no threshold; the order paid
// first first, the hold says since when it waits), fraud_warnings_shipped the orders already sent
// the provider warned of in the last days (only an alert: a hold would keep them from being
// delivered), payment_reviews the orders a review of the provider holds until it closes. Root alone
// has them, each root for themselves; a case is an order. An order held for a check is not one the
// shop sends: it is no case of the paid orders to ship.
//
// The alerts of the shop are shared by every file that runs at the same time, so a test looks at
// its own cases: the list narrowed to the buyer of the test, and the cases the actor can put aside,
// which the server lets only for a case the alert counts now. The warning of an order sent takes
// the clock of the database and the alerts count their days from the clock of the app: a margin of
// an hour on both sides of a day keeps the check clear of the small difference the two clocks may
// have.

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
let clock: { restore: () => void } | null = null;

const DAY = 86_400_000;
const HOUR = 3_600_000;

const alerts = alertsOf({ app: () => app, csrf: () => csrf });
const {
  alertOf,
  idsOf,
  dismiss,
  setThreshold,
  subscriptionOf,
  expectCounted,
  expectNotCounted,
  expectListed,
  expectCases,
} = alerts;

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
});

afterEach(() => {
  clock?.restore();
  clock = null;
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const runClock = (ms: number) => {
  clock?.restore();
  clock = moveClock(ms);
};

async function paidOrder(stage: 'paid' | 'shipped' = 'paid') {
  const buyer = await newUser({ name: 'Anna Koval' });
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 1, stage });
  return { ...placed, buyer };
}

// the provider warns of fraud of the payment, and Stripe tells of it
async function warn(paymentId: string) {
  const res = await deliver(
    app,
    craftEvent('radar.early_fraud_warning.created', await earlyFraudWarningOf(paymentId)),
  );
  expect(res.statusCode).toBe(200);
}

// the provider opens a review of the payment, or closes it (approved)
async function review(paymentId: string, id: string, open: boolean) {
  const object = await paymentReviewOf(paymentId, open ? { id } : { id, closedReason: 'approved' });
  const res = await deliver(app, craftEvent(open ? 'review.opened' : 'review.closed', object));
  expect(res.statusCode).toBe(200);
}

const decide = (orderId: number, decision: 'ship' | 'cancel') =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/holds/fraud_warning/decision`,
    headers: withCsrf(csrf, accessCookie(root)),
    payload: { decision, note: 'The buyer showed the card' },
  });

const KINDS = ['fraud_warnings', 'fraud_warnings_shipped', 'payment_reviews'];

describe('the kinds of the checks of a payment', () => {
  it('are of root alone, after the refunds made by hand, with the days of the orders sent only', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const rootKinds = (await alerts.alerts(root)).map((alert) => alert.kind);
    const adminKinds = (await alerts.alerts(someone)).map((alert) => alert.kind);

    expect(rootKinds.indexOf('fraud_warnings')).toBe(
      rootKinds.indexOf('hand_refunds_to_decide') + 1,
    );
    expect(rootKinds.slice(rootKinds.indexOf('fraud_warnings'))).toEqual([
      ...KINDS,
      'admin_actions',
    ]);
    for (const kind of KINDS) {
      expect(adminKinds).not.toContain(kind);
      const res = await setThreshold(someone, kind, 3);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'ALERT_KIND_NOT_FOUND' });
    }
    expect(await subscriptionOf(root, 'fraud_warnings')).toEqual({
      kind: 'fraud_warnings',
      subscribed: true,
      threshold: null,
    });
    expect(await subscriptionOf(root, 'payment_reviews')).toMatchObject({ threshold: null });
    expect(await subscriptionOf(root, 'fraud_warnings_shipped')).toEqual({
      kind: 'fraud_warnings_shipped',
      subscribed: true,
      threshold: { value: 7, default: 7, min: 1, max: 365, unit: 'days', custom: false },
    });
  });

  it('name the lists of the orders', async () => {
    expect(await alertOf(root, 'fraud_warnings')).toMatchObject({
      list: {
        path: '/api/orders',
        query: { statuses: 'paid', holds: 'fraud_warning', sortBy: 'paidAt', sortDir: 'asc' },
      },
    });
    expect(await alertOf(root, 'payment_reviews')).toMatchObject({
      list: { path: '/api/orders', query: { statuses: 'paid', holds: 'payment_review' } },
    });
    const shipped = await alertOf(root, 'fraud_warnings_shipped');
    expect(shipped.list!.path).toBe('/api/orders');
    expect(
      Math.abs(Date.now() - Date.parse(shipped.list!.query.fraudWarnedFrom!) - 7 * DAY),
    ).toBeLessThan(HOUR);
  });
});

describe('fraud_warnings', () => {
  const kind = 'fraud_warnings';

  it('counts an order not sent a warning holds, until root decides, and it is not to ship meanwhile', async () => {
    const order = await paidOrder();
    await warn(order.paymentId);
    const narrow = { userId: order.buyer.id };

    await expectCases(root, kind, narrow, [order.orderId]);
    // the hold says since when the order waits for root
    const [row] = (await alerts.listOf(root, kind, narrow)).items;
    expect(row!.holds).toEqual([
      expect.objectContaining({ reason: 'fraud_warning', since: expect.any(String) }),
    ]);
    expect(await idsOf(admin, 'paid_orders_waiting', narrow)).toEqual([]);
    await expectNotCounted(admin, 'paid_orders_waiting', order.orderId);
    expect(await idsOf(root, 'fraud_warnings_shipped', narrow)).toEqual([]);

    expect((await decide(order.orderId, 'ship')).statusCode).toBe(200);

    await expectListed(root, kind, narrow, [], [order.orderId]);
    expect(await idsOf(admin, 'paid_orders_waiting', narrow)).toEqual([order.orderId]);
    await expectCounted(admin, 'paid_orders_waiting', order.orderId);
  });

  it('counts for each root apart: one puts the case aside for themselves', async () => {
    const otherRoot = await newUser({ role: 'ROOT' });
    const order = await paidOrder();
    await warn(order.paymentId);

    expect((await dismiss(root, kind, order.orderId)).statusCode).toBe(200);

    expect((await alertOf(root, kind)).dismissed).toBe(1);
    expect((await alertOf(otherRoot, kind)).dismissed).toBe(0);
    expect((await dismiss(root, kind, order.orderId, false)).statusCode).toBe(200);
  });
});

describe('fraud_warnings_shipped', () => {
  const kind = 'fraud_warnings_shipped';

  it('counts an order sent that the provider warned of, in the days of the threshold', async () => {
    const otherRoot = await newUser({ role: 'ROOT' });
    expect((await setThreshold(otherRoot, kind, 10)).statusCode).toBe(200);
    const order = await paidOrder('shipped');
    const quiet = await paidOrder('shipped');
    await warn(order.paymentId);
    const narrow = { userId: order.buyer.id };

    await expectCases(root, kind, narrow, [order.orderId], [quiet.orderId]);
    expect(await idsOf(root, 'fraud_warnings', narrow)).toEqual([]);

    runClock(7 * DAY - HOUR);
    await expectListed(root, kind, narrow, [order.orderId]);

    runClock(7 * DAY + HOUR);
    await expectListed(root, kind, narrow, [], [order.orderId]);
    await expectListed(otherRoot, kind, narrow, [order.orderId]);
  });
});

describe('payment_reviews', () => {
  const kind = 'payment_reviews';

  it('counts an order not sent a review holds, until the review closes', async () => {
    const order = await paidOrder();
    const sent = await paidOrder('shipped');
    const id = `prv_alerts_${order.orderId}`;
    await review(order.paymentId, id, true);
    // a review of an order sent holds nothing
    await review(sent.paymentId, `prv_alerts_${sent.orderId}`, true);

    await expectCases(root, kind, { userId: order.buyer.id }, [order.orderId], [sent.orderId]);
    expect(await idsOf(root, kind, { userId: sent.buyer.id })).toEqual([]);

    await review(order.paymentId, id, false);

    await expectListed(root, kind, { userId: order.buyer.id }, [], [order.orderId]);
  });
});

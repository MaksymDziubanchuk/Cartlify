import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { setUserContext } from '@db/dbContext.service.js';
import { prisma } from '@db/client.js';
import { closeRedis, connectRedis } from '@redis/client.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createChatThread,
  createProduct,
  createUser,
  receiveBatch,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { placeOrder } from '../../../helpers/orders.js';
import { moveClock } from '../../../helpers/payments.js';

// the alerts of an admin (GET /api/admin/alerts): each kind of the work of an admin with how many
// cases wait, its threshold and the ready request to the list of the app that shows the cases;
// root has the actions of the admins too. Each admin and each root turns a kind off and on, sets
// its threshold and puts single cases aside (in redis) for themselves. Other files make orders,
// products and chats at the same time, so a test looks for its own cases: in the list of a kind
// (narrowed to its own rows) and among the cases the admin can put aside, which the server lets
// only for a case the alert counts now

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
let clock: { restore: () => void } | null = null;

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
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const DAY = 86_400_000;

type AlertList = { path: string; query: Record<string, string> };
type Alert = {
  kind: string;
  subscribed: boolean;
  count: number;
  dismissed: number;
  threshold: number | null;
  list: AlertList | null;
};
type Alerts = { alerts: Alert[]; total: number; dismissalsAvailable: boolean };

const ADMIN_KINDS = [
  'paid_orders_waiting',
  'shipped_orders_waiting',
  'out_of_stock',
  'low_stock',
  'expiring_batches',
  'expired_batches',
  'chats_waiting',
  'refunded_payments',
  'worker_stalled',
];

// the token is signed at each request: a test that runs the clock forward gets one of that time
const get = (actor: TestUser, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

const change = (actor: TestUser, method: 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    ...(payload ? { payload } : {}),
  });

const alertsOf = async (actor: TestUser, query = '') => {
  const res = await get(actor, `/api/admin/alerts${query}`);
  expect(res.statusCode).toBe(200);
  return res.json() as Alerts;
};

const alertOf = async (actor: TestUser, kind: string) =>
  (await alertsOf(actor)).alerts.find((alert) => alert.kind === kind)!;

// the list the alert of a kind names, narrowed to the rows of the test
const listOf = async (actor: TestUser, kind: string, narrow: Record<string, string | number>) => {
  const { list } = await alertOf(actor, kind);
  const query = new URLSearchParams({
    ...list!.query,
    ...Object.fromEntries(Object.entries(narrow).map(([key, value]) => [key, String(value)])),
  });
  const res = await get(actor, `${list!.path}?${query}`);
  expect(res.statusCode).toBe(200);
  return res.json() as { items: Array<{ id: number | string }>; total: number };
};

const idsIn = (page: { items: Array<{ id: number | string }> }) => page.items.map((row) => row.id);

const turn = (actor: TestUser, kind: string, on: boolean) =>
  change(actor, on ? 'PUT' : 'DELETE', `/api/admin/alerts/subscriptions/${kind}`);

const setThreshold = (actor: TestUser, kind: string, value: unknown) =>
  change(actor, 'PUT', `/api/admin/alerts/subscriptions/${kind}/threshold`, { value });

const resetThreshold = (actor: TestUser, kind: string) =>
  change(actor, 'DELETE', `/api/admin/alerts/subscriptions/${kind}/threshold`);

const dismiss = (actor: TestUser, kind: string, id: number | string, on = true) =>
  change(actor, on ? 'PUT' : 'DELETE', `/api/admin/alerts/dismissals/${kind}/${id}`);

const dismissalsOf = (actor: TestUser) => get(actor, '/api/admin/alerts/dismissals');

// the alert counts the case now: the server lets the admin put it aside, and names it aside
async function expectCounted(actor: TestUser, kind: string, id: number | string) {
  const res = await dismiss(actor, kind, id);
  expect(res.statusCode).toBe(200);
  expect((await alertOf(actor, kind)).dismissed).toBe(1);
  expect((await dismiss(actor, kind, id, false)).statusCode).toBe(200);
}

async function expectNotCounted(actor: TestUser, kind: string, id: number | string) {
  const res = await dismiss(actor, kind, id);
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ errorCode: 'ALERT_ITEM_NOT_FOUND' });
}

const runClock = (ms: number) => {
  clock?.restore();
  clock = moveClock(ms);
};

const day = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const paidOrder = async () =>
  placeOrder(app, csrf, await newUser(), await createProduct({ price: 10, stock: 5 }), 'paid');

const shippedOrder = async () =>
  placeOrder(app, csrf, await newUser(), await createProduct({ price: 10, stock: 5 }), 'shipped');

// a line of the admin log, the way the late payment refund writes one (field refund) or another
async function logLine(actor: TestUser, orderId: number, field: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: actor.id, role: actor.role });
    await tx.$executeRaw`select cartlify.log_admin_action(
      ${actor.id}::int, ${actor.role}::cartlify."Role", 'order'::cartlify."AdminAuditEntityType",
      ${orderId}::int, 'OTHER'::cartlify."AdminAuditAction",
      ${JSON.stringify([{ field, new: { provider: 'stripe', paymentId: `pi_${orderId}` } }])}::jsonb)`;
    const [line] = await tx.$queryRaw<{ id: number }[]>`
      select id from cartlify.admin_audit_log
      where "entityId" = ${orderId} and "actorId" = ${actor.id}
      order by id desc limit 1`;
    return line!.id;
  });
}

describe('GET /api/admin/alerts', () => {
  it('names every kind of an admin with its count, threshold and list', async () => {
    const { alerts, total, dismissalsAvailable } = await alertsOf(admin);

    expect(alerts.map((alert) => alert.kind)).toEqual(ADMIN_KINDS);
    expect(total).toBe(alerts.reduce((sum, alert) => sum + alert.count, 0));
    expect(dismissalsAvailable).toBe(true);
    expect(alerts.find((alert) => alert.kind === 'paid_orders_waiting')).toMatchObject({
      subscribed: true,
      dismissed: 0,
      threshold: null,
      list: {
        path: '/api/orders',
        query: { statuses: 'paid', sortBy: 'paidAt', sortDir: 'asc' },
      },
    });
    expect(alerts.find((alert) => alert.kind === 'low_stock')).toMatchObject({
      threshold: 5,
      list: {
        path: '/api/products',
        query: { inStock: 'true', maxStock: '5', sort: 'stock', order: 'asc' },
      },
    });
    expect(alerts.find((alert) => alert.kind === 'worker_stalled')).toMatchObject({
      threshold: 180,
      list: null,
    });
  });

  it('gives root the actions of the admins too', async () => {
    const { alerts } = await alertsOf(root);

    expect(alerts.map((alert) => alert.kind)).toEqual([...ADMIN_KINDS, 'admin_actions']);
    expect(alerts.find((alert) => alert.kind === 'admin_actions')).toMatchObject({
      threshold: 24,
      list: { path: '/api/admin/audit-log', query: { actorRole: 'ADMIN' } },
    });
  });

  it('names a kind turned off too, and with subscribed=true only the kinds that are on', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    await turn(someone, 'low_stock', false);

    const all = await alertsOf(someone);
    const on = await alertsOf(someone, '?subscribed=true');

    expect(all.alerts.find((alert) => alert.kind === 'low_stock')).toMatchObject({
      subscribed: false,
    });
    expect(on.alerts.map((alert) => alert.kind)).toEqual(
      ADMIN_KINDS.filter((kind) => kind !== 'low_stock'),
    );
    expect(on.total).toBe(on.alerts.reduce((sum, alert) => sum + alert.count, 0));
  });

  // the reservation worker does not run in the tests: nothing says it stopped
  it('names no stop of a worker that was not started', async () => {
    expect(await alertOf(admin, 'worker_stalled')).toMatchObject({ count: 0 });
  });

  it('refuses a user', async () => {
    const res = await get(await newUser(), '/api/admin/alerts');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('the cases of each kind: the alert counts what its list shows', () => {
  it('paid orders to ship', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const paid = await paidOrder();
    const shipped = await shippedOrder();

    expect(idsIn(await listOf(someone, 'paid_orders_waiting', { q: paid }))).toEqual([paid]);
    expect(idsIn(await listOf(someone, 'paid_orders_waiting', { q: shipped }))).toEqual([]);
    await expectCounted(someone, 'paid_orders_waiting', paid);
    await expectNotCounted(someone, 'paid_orders_waiting', shipped);
  });

  it('shipped orders not delivered for the days of the threshold', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const shipped = await shippedOrder();
    await setThreshold(someone, 'shipped_orders_waiting', 2);

    expect(idsIn(await listOf(someone, 'shipped_orders_waiting', { q: shipped }))).toEqual([]);
    await expectNotCounted(someone, 'shipped_orders_waiting', shipped);

    runClock(3 * DAY);

    expect(idsIn(await listOf(someone, 'shipped_orders_waiting', { q: shipped }))).toEqual([
      shipped,
    ]);
    await expectCounted(someone, 'shipped_orders_waiting', shipped);
  });

  it('products of the catalog with no free units', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const none = await createProduct({ price: 10, stock: 0 });
    const some = await createProduct({ price: 10, stock: 3 });

    expect(idsIn(await listOf(someone, 'out_of_stock', { categoryIds: none.categoryId }))).toEqual([
      none.id,
    ]);
    expect(idsIn(await listOf(someone, 'out_of_stock', { categoryIds: some.categoryId }))).toEqual(
      [],
    );
    await expectCounted(someone, 'out_of_stock', none.id);
    await expectNotCounted(someone, 'out_of_stock', some.id);
  });

  it('products of the catalog with free units up to the threshold', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const few = await createProduct({ price: 10, stock: 2 });
    const more = await createProduct({ price: 10, stock: 8 });

    expect(idsIn(await listOf(someone, 'low_stock', { categoryIds: few.categoryId }))).toEqual([
      few.id,
    ]);
    expect(idsIn(await listOf(someone, 'low_stock', { categoryIds: more.categoryId }))).toEqual([]);
    await expectCounted(someone, 'low_stock', few.id);
    await expectNotCounted(someone, 'low_stock', more.id);

    await setThreshold(someone, 'low_stock', 10);

    expect(idsIn(await listOf(someone, 'low_stock', { categoryIds: more.categoryId }))).toEqual([
      more.id,
    ]);
    await expectCounted(someone, 'low_stock', more.id);
  });

  it('batches whose last good day is within the days of the threshold', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const product = await createProduct({ price: 10, stock: 0 });
    const soon = await receiveBatch(product.id, { quantity: 3, expiresAt: day(3) });
    const later = await receiveBatch(product.id, { quantity: 3, expiresAt: day(30) });

    expect(idsIn(await listOf(someone, 'expiring_batches', { productId: product.id }))).toEqual([
      soon,
    ]);
    await expectCounted(someone, 'expiring_batches', soon);
    await expectNotCounted(someone, 'expiring_batches', later);

    await setThreshold(someone, 'expiring_batches', 40);

    expect(
      idsIn(await listOf(someone, 'expiring_batches', { productId: product.id })).sort(),
    ).toEqual([soon, later].sort());
  });

  it('batches that are over with units left', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const product = await createProduct({ price: 10, stock: 0 });
    const over = await receiveBatch(product.id, { quantity: 3, expiresAt: day(1) });
    const good = await receiveBatch(product.id, { quantity: 3, expiresAt: day(30) });

    runClock(3 * DAY);

    expect(idsIn(await listOf(someone, 'expired_batches', { productId: product.id }))).toEqual([
      over,
    ]);
    await expectCounted(someone, 'expired_batches', over);
    await expectNotCounted(someone, 'expired_batches', good);
  });

  it('chats with a message that waits for an admin', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const waiting = await createChatThread((await newUser()).id, { type: 'admin' });
    const bot = await createChatThread((await newUser()).id, { type: 'bot' });

    // the queue has no filter of a chat: its pages are walked
    const { list } = await alertOf(someone, 'chats_waiting');
    expect(list).toEqual({ path: '/api/chat/admin/threads', query: { queue: 'unread' } });
    const seen: string[] = [];
    for (let page = 1; page < 50; page++) {
      const res = await get(
        someone,
        `${list!.path}?${new URLSearchParams({ ...list!.query, page: String(page), limit: '100' })}`,
      );
      const items = res.json().items as Array<{ id: string }>;
      seen.push(...items.map((item) => item.id));
      if (items.length < 100) break;
    }

    expect(seen).toContain(waiting.id);
    expect(seen).not.toContain(bot.id);
    await expectCounted(someone, 'chats_waiting', waiting.id);
    await expectNotCounted(someone, 'chats_waiting', bot.id);
  });

  it('late payments given back within the days of the threshold', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const orderId = await paidOrder();
    const refund = await logLine(someone, orderId, 'refund');
    const other = await logLine(someone, orderId, 'note');

    expect(idsIn(await listOf(someone, 'refunded_payments', { entityId: orderId }))).toEqual([
      refund,
    ]);
    await expectCounted(someone, 'refunded_payments', refund);
    await expectNotCounted(someone, 'refunded_payments', other);

    runClock(8 * DAY);

    expect(idsIn(await listOf(someone, 'refunded_payments', { entityId: orderId }))).toEqual([]);
    await expectNotCounted(someone, 'refunded_payments', refund);
  });

  it('the actions of the admins for root within the hours of the threshold', async () => {
    const someRoot = await newUser({ role: 'ROOT' });
    const someAdmin = await newUser({ role: 'ADMIN' });
    const orderId = await paidOrder();
    const ofAdmin = await logLine(someAdmin, orderId, 'note');
    const ofRoot = await logLine(someRoot, orderId, 'note');

    expect(idsIn(await listOf(someRoot, 'admin_actions', { actorId: someAdmin.id }))).toEqual([
      ofAdmin,
    ]);
    expect(idsIn(await listOf(someRoot, 'admin_actions', { actorId: someRoot.id }))).toEqual([]);
    await expectCounted(someRoot, 'admin_actions', ofAdmin);
    await expectNotCounted(someRoot, 'admin_actions', ofRoot);

    await setThreshold(someRoot, 'admin_actions', 1);
    runClock(2 * 3_600_000);

    expect(idsIn(await listOf(someRoot, 'admin_actions', { actorId: someAdmin.id }))).toEqual([]);
  });
});

describe('the subscriptions to the alerts', () => {
  const subscriptionsOf = async (actor: TestUser) => {
    const res = await get(actor, '/api/admin/alerts/subscriptions');
    expect(res.statusCode).toBe(200);
    return res.json().items as Array<{ kind: string; subscribed: boolean; threshold: unknown }>;
  };

  const itemOf = async (actor: TestUser, kind: string) =>
    (await subscriptionsOf(actor)).find((item) => item.kind === kind);

  it('has every kind on with the threshold the server gives for a new admin', async () => {
    const items = await subscriptionsOf(await newUser({ role: 'ADMIN' }));

    expect(items.map((item) => item.kind)).toEqual(ADMIN_KINDS);
    expect(items.every((item) => item.subscribed)).toBe(true);
    expect(items.find((item) => item.kind === 'paid_orders_waiting')!.threshold).toBeNull();
    expect(Object.fromEntries(items.map((item) => [item.kind, item.threshold]))).toMatchObject({
      shipped_orders_waiting: {
        value: 14,
        default: 14,
        min: 1,
        max: 365,
        unit: 'days',
        custom: false,
      },
      low_stock: { value: 5, default: 5, min: 1, max: 100_000, unit: 'units', custom: false },
      expiring_batches: { value: 7, default: 7, min: 1, max: 365, unit: 'days', custom: false },
      refunded_payments: { value: 7, default: 7, min: 1, max: 365, unit: 'days', custom: false },
      worker_stalled: {
        value: 180,
        default: 180,
        min: 60,
        max: 86_400,
        unit: 'seconds',
        custom: false,
      },
    });
  });

  it('gives root the threshold of the actions of the admins', async () => {
    expect(await itemOf(await newUser({ role: 'ROOT' }), 'admin_actions')).toEqual({
      kind: 'admin_actions',
      subscribed: true,
      threshold: { value: 24, default: 24, min: 1, max: 720, unit: 'hours', custom: false },
    });
  });

  it('turns a kind off and on for one admin only, and keeps its threshold', async () => {
    const first = await newUser({ role: 'ADMIN' });
    const second = await newUser({ role: 'ADMIN' });
    await setThreshold(first, 'low_stock', 12);

    const off = await turn(first, 'low_stock', false);

    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({
      kind: 'low_stock',
      subscribed: false,
      threshold: { value: 12, custom: true },
    });
    expect((await alertOf(first, 'low_stock')).subscribed).toBe(false);
    expect((await alertOf(second, 'low_stock')).subscribed).toBe(true);

    const on = await turn(first, 'low_stock', true);

    expect(on.json()).toMatchObject({ subscribed: true, threshold: { value: 12 } });
    expect(await alertOf(first, 'low_stock')).toMatchObject({ subscribed: true, threshold: 12 });
  });

  it('takes a kind turned off twice as off', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    await turn(someone, 'chats_waiting', false);

    const again = await turn(someone, 'chats_waiting', false);

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ kind: 'chats_waiting', subscribed: false });
  });

  it('lets root turn off the actions of the admins', async () => {
    const someone = await newUser({ role: 'ROOT' });

    expect((await turn(someone, 'admin_actions', false)).statusCode).toBe(200);
    expect((await alertOf(someone, 'admin_actions')).subscribed).toBe(false);
  });

  it.each([
    ['a kind there is not', 'something_else'],
    ['a kind of root for an admin', 'admin_actions'],
  ])('answers 404 for %s', async (_case, kind) => {
    const res = await turn(admin, kind, false);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ALERT_KIND_NOT_FOUND' });
  });
});

describe('PUT /api/admin/alerts/subscriptions/:kind/threshold', () => {
  it('keeps the threshold an admin sets, for that admin only, until it is reset', async () => {
    const first = await newUser({ role: 'ADMIN' });
    const second = await newUser({ role: 'ADMIN' });

    const res = await setThreshold(first, 'shipped_orders_waiting', 3);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: 'shipped_orders_waiting',
      subscribed: true,
      threshold: { value: 3, default: 14, min: 1, max: 365, unit: 'days', custom: true },
    });
    expect((await alertOf(first, 'shipped_orders_waiting')).threshold).toBe(3);
    expect((await alertOf(second, 'shipped_orders_waiting')).threshold).toBe(14);

    const reset = await resetThreshold(first, 'shipped_orders_waiting');

    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ threshold: { value: 14, custom: false } });
    expect((await alertOf(first, 'shipped_orders_waiting')).threshold).toBe(14);
  });

  it('keeps a kind turned off off when its threshold is set', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    await turn(someone, 'low_stock', false);

    const res = await setThreshold(someone, 'low_stock', 20);

    expect(res.json()).toMatchObject({ subscribed: false, threshold: { value: 20 } });
  });

  it.each([
    ['shipped_orders_waiting', 366, { min: 1, max: 365 }],
    ['worker_stalled', 30, { min: 60, max: 86_400 }],
  ])('answers ALERT_THRESHOLD_INVALID for %s at %p', async (kind, value, range) => {
    const res = await setThreshold(await newUser({ role: 'ADMIN' }), kind, value);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ALERT_THRESHOLD_INVALID', details: range });
  });

  it.each([0, 1.5, 'often', null])('refuses a threshold of %p', async (value) => {
    const res = await setThreshold(await newUser({ role: 'ADMIN' }), 'low_stock', value);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('answers ALERT_THRESHOLD_NOT_FOUND for a kind without a threshold', async () => {
    const res = await setThreshold(await newUser({ role: 'ADMIN' }), 'paid_orders_waiting', 3);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ALERT_THRESHOLD_NOT_FOUND' });
  });

  it('answers ALERT_KIND_NOT_FOUND for a kind of root for an admin', async () => {
    const res = await setThreshold(await newUser({ role: 'ADMIN' }), 'admin_actions', 3);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ALERT_KIND_NOT_FOUND' });
  });

  it('refuses a user', async () => {
    const res = await setThreshold(await newUser(), 'low_stock', 3);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('a case of an alert put aside', () => {
  it('leaves the count of the admin who put it aside, for that admin only', async () => {
    const orderId = await paidOrder();
    const someone = await newUser({ role: 'ADMIN' });
    const other = await newUser({ role: 'ADMIN' });

    const res = await dismiss(someone, 'paid_orders_waiting', orderId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: 'paid_orders_waiting',
      id: String(orderId),
      dismissed: true,
    });
    expect((await alertOf(someone, 'paid_orders_waiting')).dismissed).toBe(1);
    expect((await alertOf(other, 'paid_orders_waiting')).dismissed).toBe(0);
  });

  it('is listed for the admin and comes back when the admin takes it back', async () => {
    const orderId = await paidOrder();
    const someone = await newUser({ role: 'ADMIN' });
    await dismiss(someone, 'paid_orders_waiting', orderId);

    expect((await dismissalsOf(someone)).json()).toEqual({
      items: [
        { kind: 'paid_orders_waiting', id: String(orderId), dismissedAt: expect.any(String) },
      ],
    });

    const back = await dismiss(someone, 'paid_orders_waiting', orderId, false);

    expect(back.statusCode).toBe(200);
    expect(back.json()).toEqual({
      kind: 'paid_orders_waiting',
      id: String(orderId),
      dismissed: false,
    });
    expect((await alertOf(someone, 'paid_orders_waiting')).dismissed).toBe(0);
    expect((await dismissalsOf(someone)).json()).toEqual({ items: [] });
  });

  it('goes by itself once the case is over', async () => {
    const orderId = await paidOrder();
    const someone = await newUser({ role: 'ADMIN' });
    await dismiss(someone, 'paid_orders_waiting', orderId);

    const shipped = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: withCsrf(csrf, accessCookie(someone)),
      payload: { status: 'shipped' },
    });
    expect(shipped.statusCode).toBe(200);

    expect((await alertOf(someone, 'paid_orders_waiting')).dismissed).toBe(0);
    expect((await dismissalsOf(someone)).json()).toEqual({ items: [] });
  });

  it('takes a case put aside twice as aside', async () => {
    const orderId = await paidOrder();
    const someone = await newUser({ role: 'ADMIN' });
    await dismiss(someone, 'paid_orders_waiting', orderId);

    const again = await dismiss(someone, 'paid_orders_waiting', orderId);

    expect(again.statusCode).toBe(200);
    expect((await alertOf(someone, 'paid_orders_waiting')).dismissed).toBe(1);
  });

  it.each([
    ['a kind there is not', 'something_else'],
    ['a kind with no cases', 'worker_stalled'],
    ['a kind of root for an admin', 'admin_actions'],
  ])('answers ALERT_KIND_NOT_FOUND for %s', async (_case, kind) => {
    const res = await dismiss(await newUser({ role: 'ADMIN' }), kind, 1);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ALERT_KIND_NOT_FOUND' });
  });

  it('refuses a user', async () => {
    const res = await dismissalsOf(await newUser());

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  // the cases put aside live in redis: without it the alerts count every case, and a case is
  // not put aside or taken back
  it('counts every case while Redis is down and puts none aside', async () => {
    const orderId = await paidOrder();
    const someone = await newUser({ role: 'ADMIN' });
    await dismiss(someone, 'paid_orders_waiting', orderId);
    await closeRedis();

    try {
      const alerts = await alertsOf(someone);
      const res = await dismiss(someone, 'paid_orders_waiting', orderId, false);

      expect(alerts.dismissalsAvailable).toBe(false);
      expect(alerts.alerts.every((alert) => alert.dismissed === 0)).toBe(true);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ errorCode: 'REDIS_UNAVAILABLE' });
      expect(takeLogs({ msg: 'request failed', errorCode: 'REDIS_UNAVAILABLE' })).toHaveLength(1);
    } finally {
      await connectRedis(app.log);
    }

    expect((await alertOf(someone, 'paid_orders_waiting')).dismissed).toBe(1);
  });
});

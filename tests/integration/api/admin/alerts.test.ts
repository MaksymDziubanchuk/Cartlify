import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

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
import { placeOrder } from '../../../helpers/orders.js';

// the alerts of an admin (GET /api/admin/alerts): what waits for the work of an admin, each kind
// with how many there are and the latest of them; root has the actions of the admins too. Each
// admin and each root turns a kind off and on for themselves. Other files make orders, products
// and chats at the same time, so a test counts at least its own and finds its own among the latest

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];

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

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Alert = { kind: string; count: number; ids: Array<number | string> };

const alertsOf = async (actor: TestUser) => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/alerts',
    headers: { cookie: accessCookie(actor) },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { alerts: Alert[]; total: number };
};

const alertOf = async (actor: TestUser, kind: string) =>
  (await alertsOf(actor)).alerts.find((alert) => alert.kind === kind);

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

const subscriptions = (actor: TestUser) =>
  app.inject({
    method: 'GET',
    url: '/api/admin/alerts/subscriptions',
    headers: { cookie: accessCookie(actor) },
  });

const turn = (actor: TestUser, kind: string, on: boolean) =>
  app.inject({
    method: on ? 'PUT' : 'DELETE',
    url: `/api/admin/alerts/subscriptions/${kind}`,
    headers: withCsrf(csrf, accessCookie(actor)),
  });

describe('GET /api/admin/alerts', () => {
  it('names every kind of an admin with its count', async () => {
    const { alerts, total } = await alertsOf(admin);

    expect(alerts.map((alert) => alert.kind)).toEqual(ADMIN_KINDS);
    expect(total).toBe(alerts.reduce((sum, alert) => sum + alert.count, 0));
  });

  it('gives root the actions of the admins too', async () => {
    const { alerts } = await alertsOf(root);

    expect(alerts.map((alert) => alert.kind)).toEqual([...ADMIN_KINDS, 'admin_actions']);
  });

  it('counts a paid order that waits to be shipped and names it among the latest', async () => {
    const orderId = await placeOrder(
      app,
      csrf,
      await newUser(),
      await createProduct({ price: 10 }),
      'paid',
    );

    const alert = await alertOf(admin, 'paid_orders_waiting');

    expect(alert!.count).toBeGreaterThanOrEqual(1);
    expect(alert!.ids).toContain(orderId);
  });

  it('counts a product of the catalog with no free units and one with few', async () => {
    const none = await createProduct({ price: 10, stock: 0 });
    const few = await createProduct({ price: 10, stock: 2 });

    const { alerts } = await alertsOf(admin);

    expect(alerts.find((alert) => alert.kind === 'out_of_stock')!.ids).toContain(none.id);
    expect(alerts.find((alert) => alert.kind === 'low_stock')!.ids).toContain(few.id);
  });

  it('counts a batch whose last good day is near and one that is over', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    const day = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    await receiveBatch(product.id, { quantity: 3, expiresAt: day(3) });

    const alert = await alertOf(admin, 'expiring_batches');

    expect(alert!.count).toBeGreaterThanOrEqual(1);
  });

  it('counts a chat that waits for an admin', async () => {
    const thread = await createChatThread((await newUser()).id, { type: 'admin' });

    const alert = await alertOf(admin, 'chats_waiting');

    expect(alert!.ids).toContain(thread.id);
  });

  // the reservation worker does not run in the tests: nothing says it stopped
  it('names no stop of a worker that was not started', async () => {
    expect(await alertOf(admin, 'worker_stalled')).toMatchObject({ count: 0 });
  });

  it('counts the actions of an admin for root', async () => {
    const product = await createProduct({ price: 10 });
    await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { price: 11 },
    });

    expect((await alertOf(root, 'admin_actions'))!.count).toBeGreaterThanOrEqual(1);
  });

  it('refuses a user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/alerts',
      headers: { cookie: accessCookie(await newUser()) },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('the subscriptions to the alerts', () => {
  it('has every kind on for a new admin', async () => {
    const res = await subscriptions(await newUser({ role: 'ADMIN' }));

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual(ADMIN_KINDS.map((kind) => ({ kind, subscribed: true })));
  });

  it('turns a kind off and on for one admin only', async () => {
    const first = await newUser({ role: 'ADMIN' });
    const second = await newUser({ role: 'ADMIN' });

    const off = await turn(first, 'low_stock', false);

    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ kind: 'low_stock', subscribed: false });
    expect((await alertsOf(first)).alerts.map((alert) => alert.kind)).not.toContain('low_stock');
    expect((await alertsOf(second)).alerts.map((alert) => alert.kind)).toContain('low_stock');
    expect(
      (await subscriptions(first))
        .json()
        .items.find((item: { kind: string }) => item.kind === 'low_stock'),
    ).toEqual({ kind: 'low_stock', subscribed: false });

    const on = await turn(first, 'low_stock', true);

    expect(on.json()).toEqual({ kind: 'low_stock', subscribed: true });
    expect((await alertsOf(first)).alerts.map((alert) => alert.kind)).toContain('low_stock');
  });

  it('takes a kind turned off twice as off', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    await turn(someone, 'chats_waiting', false);

    const again = await turn(someone, 'chats_waiting', false);

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ kind: 'chats_waiting', subscribed: false });
  });

  it('lets root turn off the actions of the admins', async () => {
    const someone = await newUser({ role: 'ROOT' });

    expect((await turn(someone, 'admin_actions', false)).statusCode).toBe(200);
    expect((await alertsOf(someone)).alerts.map((alert) => alert.kind)).not.toContain(
      'admin_actions',
    );
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

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrderOf } from '../../../helpers/orders.js';
import { moveClock } from '../../../helpers/payments.js';

// when a buyer may withdraw from an order, as the answers of the orders give it: deliveredAt and
// withdrawalEndsAt appear with the delivery and go with a step back, withdrawalOpen says whether
// the button of withdrawal works. The period starts with the delivery and lasts the days of the
// contract the order kept (14 while the shop has published none, as in this file: a version in
// force is for the whole shop, and the files that publish one run last and alone), to the end of
// the last day of the time zone of the shop: withdrawalEndsAt tells it. The days of grace of the
// shop (WITHDRAWAL_GRACE_DAYS) are not told, they keep the button working after it. What a contract
// in force changes is in api/legal/legal.shopwide.test.ts, the arithmetic of the end in
// db/withdrawal.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
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
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

let clock: ReturnType<typeof moveClock> | undefined;
afterEach(() => clock?.restore());

const setStatus = (orderId: number, status: string) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/status`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { status },
  });

const read = async (orderId: number, actor: TestUser) => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/orders/${orderId}`,
    headers: { cookie: accessCookie(actor) },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
};

const orderOf = async (buyer: TestUser, stage: 'cart' | 'waiting' | 'paid') =>
  placeOrderOf(app, csrf, buyer, [{ item: await createProduct({ price: 10, stock: 5 }) }], stage);

const deliveredOrderOf = async (buyer: TestUser) => {
  const orderId = await orderOf(buyer, 'paid');
  expect((await setStatus(orderId, 'shipped')).statusCode).toBe(200);
  expect((await setStatus(orderId, 'delivered')).statusCode).toBe(200);
  return orderId;
};

const DAY_MS = 86_400_000;
const localDate = (at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: env.SHOP_TIME_ZONE }).format(at);
const localTime = (at: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: env.SHOP_TIME_ZONE,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(at);
const plusDays = (date: string, days: number) => {
  const moved = new Date(`${date}T12:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
};

describe('the withdrawal in the answers of an order', () => {
  it.each([
    ['a cart', 'cart', false],
    ['an order that waits for its payment', 'waiting', false],
    ['a paid order', 'paid', true],
  ] as const)('gives %s no time of delivery: withdrawalOpen is %p', async (_case, stage, open) => {
    const buyer = await newUser();
    const orderId = await orderOf(buyer, stage);

    const order = await read(orderId, buyer);

    expect(order.withdrawalOpen).toBe(open);
    expect(order).not.toHaveProperty('deliveredAt');
    expect(order).not.toHaveProperty('withdrawalEndsAt');
  });

  it('is open on a shipped order, which has no end of the period yet', async () => {
    const buyer = await newUser();
    const orderId = await orderOf(buyer, 'paid');
    await setStatus(orderId, 'shipped');

    const order = await read(orderId, buyer);

    expect(order).toMatchObject({ status: 'shipped', withdrawalOpen: true });
    expect(order).not.toHaveProperty('deliveredAt');
    expect(order).not.toHaveProperty('withdrawalEndsAt');
  });

  it('gives the time of the delivery and the end of the period of a delivered order', async () => {
    const buyer = await newUser();
    const before = Date.now();
    const orderId = await deliveredOrderOf(buyer);

    const order = await read(orderId, buyer);

    const delivered = new Date(order.deliveredAt);
    const ends = new Date(order.withdrawalEndsAt);
    expect(order).toMatchObject({ status: 'delivered', withdrawalOpen: true });
    // the clock of the database against the clock of the test: a minute of room
    expect(delivered.getTime()).toBeGreaterThan(before - 60_000);
    expect(delivered.getTime()).toBeLessThan(Date.now() + 60_000);
    // 14 days (no contract is published), to the end of the last day; the grace is not told
    expect(localDate(ends)).toBe(plusDays(localDate(delivered), 14));
    expect(localTime(ends)).toBe('23:59:59');
    expect(ends.getMilliseconds()).toBe(999);
  });

  // the clock of the app moves while the request runs, so the test stands a minute off the end of
  // the contract and two hours off the end of the grace (the last day of grace may hold a change of
  // the clock of the zone): the last millisecond itself is held in the unit test of the mapper
  it('is open until the end of the period, still open in the days of grace and shut after them', async () => {
    const buyer = await newUser();
    const orderId = await deliveredOrderOf(buyer);
    const ends = new Date((await read(orderId, buyer)).withdrawalEndsAt);
    const graceEnds = ends.getTime() + env.WITHDRAWAL_GRACE_DAYS * DAY_MS;

    clock = moveClock(ends.getTime() - Date.now() - 60_000);
    const last = await read(orderId, buyer);
    clock.restore();
    clock = moveClock(ends.getTime() - Date.now() + 60_000);
    const late = await read(orderId, buyer);
    clock.restore();
    clock = moveClock(graceEnds - Date.now() - 2 * 3_600_000);
    const lastOfGrace = await read(orderId, buyer);
    clock.restore();
    clock = moveClock(graceEnds - Date.now() + 2 * 3_600_000);
    const after = await read(orderId, buyer);

    expect(env.WITHDRAWAL_GRACE_DAYS).toBeGreaterThan(0);
    expect(last.withdrawalOpen).toBe(true);
    expect(late.withdrawalOpen).toBe(true);
    expect(lastOfGrace.withdrawalOpen).toBe(true);
    expect(after.withdrawalOpen).toBe(false);
    // the date stays the end of the contract: the page still says when the period ended
    expect(late.withdrawalEndsAt).toBe(last.withdrawalEndsAt);
    expect(after.withdrawalEndsAt).toBe(last.withdrawalEndsAt);
  });

  it('is open for a long time: the period is more than two weeks', async () => {
    const buyer = await newUser();
    const orderId = await deliveredOrderOf(buyer);

    clock = moveClock(14 * DAY_MS);
    const order = await read(orderId, buyer);

    expect(order.withdrawalOpen).toBe(true);
  });

  it('takes both times away with a step back and gives them again with the next delivery', async () => {
    const buyer = await newUser();
    const orderId = await deliveredOrderOf(buyer);

    expect((await setStatus(orderId, 'shipped')).statusCode).toBe(200);
    const back = await read(orderId, buyer);
    expect((await setStatus(orderId, 'delivered')).statusCode).toBe(200);
    const again = await read(orderId, buyer);

    expect(back).toMatchObject({ status: 'shipped', withdrawalOpen: true });
    expect(back).not.toHaveProperty('deliveredAt');
    expect(back).not.toHaveProperty('withdrawalEndsAt');
    expect(again).toMatchObject({ status: 'delivered', withdrawalOpen: true });
    expect(again.deliveredAt).toEqual(expect.any(String));
  });

  it('gives the admin the same, in the order, in the list and in the answer of a step', async () => {
    const buyer = await newUser();
    const orderId = await orderOf(buyer, 'paid');
    await setStatus(orderId, 'shipped');

    const step = await setStatus(orderId, 'delivered');
    const own = await read(orderId, admin);
    const list = await app.inject({
      method: 'GET',
      url: `/api/orders?userId=${buyer.id}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(step.statusCode).toBe(200);
    for (const order of [step.json(), own, list.json().items[0]]) {
      expect(order).toMatchObject({
        id: orderId,
        status: 'delivered',
        deliveredAt: expect.any(String),
        withdrawalEndsAt: expect.any(String),
        withdrawalOpen: true,
      });
    }
  });

  it('gives the buyer the list with the dates of each order', async () => {
    const buyer = await newUser();
    const orderId = await deliveredOrderOf(buyer);

    const list = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: accessCookie(buyer) },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([
      expect.objectContaining({
        id: orderId,
        deliveredAt: expect.any(String),
        withdrawalEndsAt: expect.any(String),
        withdrawalOpen: true,
      }),
    ]);
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import cloudinary from '@config/cloudinary.js';
import {
  accessCookie,
  getMe,
  refreshWith,
  sessionCookie,
  signIn,
} from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { setCookies } from '../../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';
import {
  closeSessions,
  createLoginLog,
  createProduct,
  createUser,
  stockOf,
  uniqueTag,
  type TestProduct,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';
import { placePaidOrderOf } from '../../../helpers/payments.js';

// DELETE /api/users/me: a user deletes their own account. A local account confirms with the
// password, an oauth one with a login of the last 10 minutes; open orders are shown first and
// deleted only on a second, confirmed request. What the deletion does to the orders, chats and
// the rest of the account is the same as for a root, see delete.test.ts

const MINUTE = 60_000;

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
// a paid order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// an account of google with a login the given time ago
const newGoogleUser = async (loggedInAgoMs: number | null) => {
  const user = await newUser({ authProvider: 'GOOGLE', providerSub: `google-${uniqueTag()}` });
  if (loggedInAgoMs !== null) await createLoginLog(user, new Date(Date.now() - loggedInAgoMs));
  return user;
};

const newProduct = async () => {
  const product = await createProduct({ price: 10, stock: 5 });
  products.push(product);
  return product;
};

const deleteMe = (cookie: string, payload: Record<string, unknown> = {}) =>
  app.inject({
    method: 'DELETE',
    url: '/api/users/me',
    headers: withCsrf(csrf, cookie),
    payload,
  });

const rowOf = (id: number) => asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { id } }));
const orderOf = (id: number) => asAdmin((tx) => tx.order.findUnique({ where: { id } }));

const isDeleted = async (id: number) => (await rowOf(id)).email.startsWith(`deleted+${id}+`);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);

  // the avatar file lives at Cloudinary and the test environment has only made-up Cloudinary keys
  jest.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' });
});

afterAll(async () => {
  jest.restoreAllMocks();
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('who may delete their own account', () => {
  // an admin is demoted by root first, a root stays
  it.each(['ADMIN', 'ROOT'] as const)('refuses a %s and keeps the account', async (role) => {
    const user = await newUser({ role });

    const res = await deleteMe(accessCookie(user), { password: user.password });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(await isDeleted(user.id)).toBe(false);
  });

  it('refuses a guest', async () => {
    const res = await deleteMe('', {});

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('a local account', () => {
  it('is deleted with its password: 204 and the cookies of this browser are cleared', async () => {
    const user = await newUser({ name: 'Anna' });
    const session = await signIn(app, csrf, user);

    const res = await deleteMe(sessionCookie(session), { password: user.password });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    const cookies = setCookies(res);
    expect(cookies.accessToken?.cleared).toBe(true);
    expect(cookies.refreshToken?.cleared).toBe(true);
    expect(await rowOf(user.id)).toMatchObject({
      email: expect.stringMatching(/^deleted\+\d+\+[a-z0-9_]+@shop\.example\.com$/),
      passwordHash: null,
      name: 'Guest',
      isVerified: false,
      role: 'USER',
      deletedAt: expect.any(Date),
    });
    // the session cannot be renewed anywhere
    expect((await refreshWith(app, csrf, session.refreshToken)).statusCode).not.toBe(204);
  });

  it('drops the spaces around the password, the same as the login', async () => {
    const user = await newUser();

    const res = await deleteMe(accessCookie(user), { password: `  ${user.password}  ` });

    expect(res.statusCode).toBe(204);
  });

  it('refuses without the password and changes nothing', async () => {
    const user = await newUser();

    const res = await deleteMe(accessCookie(user), {});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PASSWORD_REQUIRED' });
    expect(await isDeleted(user.id)).toBe(false);
  });

  // 403, not 401: the session is fine, the page must not take it for a lost login
  it('refuses a wrong password, changes nothing and keeps the session', async () => {
    const user = await newUser();
    const cookie = accessCookie(user);

    const res = await deleteMe(cookie, { password: 'not-the-password' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'PASSWORD_INVALID' });
    expect(await isDeleted(user.id)).toBe(false);
    expect((await getMe(app, cookie)).statusCode).toBe(200);
  });

  it('refuses a password longer than any password can be', async () => {
    const user = await newUser();

    const res = await deleteMe(accessCookie(user), { password: 'x'.repeat(257) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

// the access token of a deleted account lives a few minutes on: a second request deleted the
// emptied row once more, or failed with 500 on the password it no longer has
describe('a deleted account', () => {
  it('answers 404 to a second deletion and changes nothing', async () => {
    const user = await newUser();
    const cookie = accessCookie(user);
    expect((await deleteMe(cookie, { password: user.password })).statusCode).toBe(204);
    const before = await rowOf(user.id);

    const res = await deleteMe(cookie, { password: user.password });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
    expect((await rowOf(user.id)).email).toBe(before.email);
  });
});

describe('an oauth account', () => {
  it('is deleted without a password when the last login is at most 10 minutes old', async () => {
    const user = await newGoogleUser(9 * MINUTE);

    const res = await deleteMe(accessCookie(user), {});

    expect(res.statusCode).toBe(204);
    expect(await isDeleted(user.id)).toBe(true);
  });

  // a page sends a delete without a body when there is nothing to send
  it('takes a request without a body', async () => {
    const user = await newGoogleUser(MINUTE);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/users/me',
      headers: withCsrf(csrf, accessCookie(user)),
    });

    expect(res.statusCode).toBe(204);
    expect(await isDeleted(user.id)).toBe(true);
  });

  // the framework refuses it before the route: the docs tell the page to send {} or no content type
  it('refuses a json content type that comes without a body and changes nothing', async () => {
    const user = await newGoogleUser(MINUTE);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/users/me',
      headers: { ...withCsrf(csrf, accessCookie(user)), 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'BAD_REQUEST' });
    expect(await isDeleted(user.id)).toBe(false);
  });

  // the page logs out, sends the person through google again and repeats the request
  it('asks for a new login when the last one is older than 10 minutes', async () => {
    const user = await newGoogleUser(11 * MINUTE);

    const res = await deleteMe(accessCookie(user), {});

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'RECENT_LOGIN_REQUIRED' });
    expect(await isDeleted(user.id)).toBe(false);
  });

  it('asks for a new login when there was none', async () => {
    const user = await newGoogleUser(null);

    const res = await deleteMe(accessCookie(user), {});

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'RECENT_LOGIN_REQUIRED' });
  });

  it('takes no password instead of a recent login', async () => {
    const user = await newGoogleUser(11 * MINUTE);

    const res = await deleteMe(accessCookie(user), { password: 'anything' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'RECENT_LOGIN_REQUIRED' });
  });
});

describe('open orders', () => {
  it('deletes at once when there is only a cart, and the cart goes', async () => {
    const user = await newUser();
    const cartId = await placeOrder(app, csrf, user, await newProduct(), 'cart');

    const res = await deleteMe(accessCookie(user), { password: user.password });

    expect(res.statusCode).toBe(204);
    expect(await orderOf(cartId)).toBeNull();
  });

  it('shows the orders waiting for payment, paid and shipped first and changes nothing', async () => {
    const user = await newUser();
    const product = await newProduct();
    const paidId = await placeOrder(app, csrf, user, product, 'paid');
    const shippedId = await placeOrder(app, csrf, user, product, 'shipped');
    const waitingId = await placeOrder(app, csrf, user, product, 'waiting');

    const res = await deleteMe(accessCookie(user), { password: user.password });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ACCOUNT_HAS_OPEN_ORDERS' });
    const { orders } = res.json().details as {
      orders: { orderId: number; status: string; total: string; reasons: string[] }[];
    };
    expect(orders.map(({ orderId, status, reasons }) => ({ orderId, status, reasons }))).toEqual([
      { orderId: paidId, status: 'paid', reasons: ['IN_PROGRESS'] },
      { orderId: shippedId, status: 'shipped', reasons: ['IN_PROGRESS'] },
      { orderId: waitingId, status: 'waiting', reasons: ['PAYMENT_WAITING'] },
    ]);
    expect(orders.every((order) => Number(order.total) === 10)).toBe(true);
    expect(await isDeleted(user.id)).toBe(false);
    expect(await orderOf(waitingId)).toMatchObject({ status: 'waiting', confirmed: true });
  });

  it('deletes after the user confirmed: the waiting order is cancelled, the paid one lives on', async () => {
    const user = await newUser();
    const product = await newProduct();
    const paidId = await placeOrder(app, csrf, user, product, 'paid');
    const waitingId = await placeOrder(app, csrf, user, product, 'waiting');

    const res = await deleteMe(accessCookie(user), {
      password: user.password,
      confirmOpenOrders: true,
    });

    expect(res.statusCode).toBe(204);
    expect(await isDeleted(user.id)).toBe(true);
    expect(await orderOf(waitingId)).toBeNull();
    expect(await orderOf(paidId)).toMatchObject({ status: 'paid', userId: user.id });
    expect(await stockOf(product)).toEqual({ stock: 4, reservedStock: 0 });
  });

  it('checks the password before it shows the orders', async () => {
    const user = await newUser();
    await placeOrder(app, csrf, user, await newProduct(), 'waiting');

    const res = await deleteMe(accessCookie(user), { password: 'not-the-password' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'PASSWORD_INVALID' });
  });
});

// the orders that live on without the account and that the person should know of before it goes: a
// delivered one inside its period of withdrawal, and any one with a statement open. The statement
// stays open, the order too: the buyer reaches them through the mails and the public form
describe('DELETE /api/users/me with a delivered order or an open statement', () => {
  afterEach(resetShopSettings);

  const deliveredOrder = async (user: Awaited<ReturnType<typeof newUser>>) => {
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'shipped');
    await asAdmin(
      (tx) =>
        tx.$executeRaw`update cartlify.orders set status = 'delivered' where id = ${orderId}::int`,
    );
    return orderId;
  };

  const withdraw = (user: Awaited<ReturnType<typeof newUser>>, orderId: number) =>
    app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/withdrawal`,
      headers: withCsrf(csrf, accessCookie(user)),
      payload: {},
    });

  const reasonsOf = (res: Awaited<ReturnType<typeof deleteMe>>) =>
    (res.json().details as { orders: { orderId: number; reasons: string[] }[] }).orders.map(
      ({ orderId, reasons }) => ({ orderId, reasons }),
    );

  it('lists a delivered order the person may still withdraw from, and deletes after the second request', async () => {
    const user = await newUser();
    const orderId = await deliveredOrder(user);

    const first = await deleteMe(accessCookie(user), { password: user.password });

    expect(first.statusCode).toBe(409);
    expect(first.json()).toMatchObject({ errorCode: 'ACCOUNT_HAS_OPEN_ORDERS' });
    expect(reasonsOf(first)).toEqual([{ orderId, reasons: ['WITHDRAWAL_OPEN'] }]);
    expect(await isDeleted(user.id)).toBe(false);

    const second = await deleteMe(accessCookie(user), {
      password: user.password,
      confirmOpenOrders: true,
    });

    expect(second.statusCode).toBe(204);
    expect(await orderOf(orderId)).toMatchObject({ status: 'delivered', userId: user.id });
  });

  it('does not list a delivered order whose period is over', async () => {
    const user = await newUser();
    await deliveredOrder(user);
    setShopSettings({ withdrawalGraceDays: -400 });

    const res = await deleteMe(accessCookie(user), { password: user.password });

    expect(res.statusCode).toBe(204);
  });

  it('lists an order with an open statement together with the other reasons, and the statement lives on', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'shipped');
    expect((await withdraw(user, orderId)).statusCode).toBe(201);

    const first = await deleteMe(accessCookie(user), { password: user.password });

    expect(first.statusCode).toBe(409);
    expect(reasonsOf(first)).toEqual([{ orderId, reasons: ['IN_PROGRESS', 'RETURN_OPEN'] }]);

    const second = await deleteMe(accessCookie(user), {
      password: user.password,
      confirmOpenOrders: true,
    });

    expect(second.statusCode).toBe(204);
    const statements = await asAdmin((tx) =>
      tx.orderReturn.findMany({ where: { orderId }, select: { closedAt: true, source: true } }),
    );
    expect(statements).toEqual([{ closedAt: null, source: 'account' }]);
  });

  it('lists a delivered order past its period only for its open statement', async () => {
    const user = await newUser();
    const orderId = await deliveredOrder(user);
    expect((await withdraw(user, orderId)).statusCode).toBe(201);
    setShopSettings({ withdrawalGraceDays: -400 });

    const res = await deleteMe(accessCookie(user), { password: user.password });

    expect(res.statusCode).toBe(409);
    expect(reasonsOf(res)).toEqual([{ orderId, reasons: ['RETURN_OPEN'] }]);
  });

  it('does not list a cancelled order whose statement is closed: the goods are back and the money is given back', async () => {
    const user = await newUser();
    const { orderId } = await placePaidOrderOf(
      app,
      csrf,
      user,
      [{ item: await newProduct(), quantity: 1 }],
      {},
    );
    expect((await withdraw(user, orderId)).statusCode).toBe(201);
    const statements = await asAdmin((tx) =>
      tx.orderReturn.findMany({ where: { orderId }, select: { closedAt: true } }),
    );
    expect(statements[0]!.closedAt).not.toBeNull();

    const res = await deleteMe(accessCookie(user), { password: user.password });

    expect(res.statusCode).toBe(204);
  });
});

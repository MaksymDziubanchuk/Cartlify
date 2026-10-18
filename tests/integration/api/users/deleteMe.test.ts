import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

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
import {
  closeSessions,
  createLoginLog,
  createProduct,
  createUser,
  uniqueTag,
  type TestProduct,
} from '../../../helpers/factories.js';
import { allowLogs } from '../../../helpers/logs.js';
import { placeOrder } from '../../../helpers/orders.js';

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

  // the test environment has no SendGrid key: every deletion logs that its mail was not sent;
  // delete.test.ts checks that line
  allowLogs({ msg: 'account deleted mail was not sent', reason: 'SENDGRID_API_KEY_REQUIRED' });
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
      orders: { orderId: number; status: string; total: string }[];
    };
    expect(orders.map(({ orderId, status }) => ({ orderId, status }))).toEqual([
      { orderId: paidId, status: 'paid' },
      { orderId: shippedId, status: 'shipped' },
      { orderId: waitingId, status: 'waiting' },
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
    expect(
      await asAdmin((tx) =>
        tx.product.findUniqueOrThrow({
          where: { id: product.id },
          select: { stock: true, reservedStock: true },
        }),
      ),
    ).toEqual({ stock: 4, reservedStock: 0 });
  });

  it('checks the password before it shows the orders', async () => {
    const user = await newUser();
    await placeOrder(app, csrf, user, await newProduct(), 'waiting');

    const res = await deleteMe(accessCookie(user), { password: 'not-the-password' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'PASSWORD_INVALID' });
  });
});

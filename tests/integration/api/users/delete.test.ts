import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import cloudinary from '@config/cloudinary.js';
import env from '@config/env.js';

import {
  accessCookie,
  getMe,
  logIn,
  refreshWith,
  sessionCookie,
  signIn,
  type Session,
} from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { setCookies } from '../../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createChatThread,
  createFavorite,
  createProduct,
  createReview,
  createUser,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { allowLogs, takeLogs } from '../../../helpers/logs.js';
import { itWithMail, watchMail } from '../../../helpers/mail.js';
import { placeOrder } from '../../../helpers/orders.js';

// DELETE /api/users/:userId: only root, and it does not drop the row, it empties it: orders,
// reviews and logs keep pointing at an account that no longer holds anything personal.
// The deletion is the one the user's own DELETE /api/users/me runs (deleteMe.test.ts); what it does
// to the orders, chats and the rest of the account is tested here

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let rootCookie: string;
const userIds: number[] = [];
// a paid order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const deleteUser = (id: number | string, cookie: string) =>
  app.inject({
    method: 'DELETE',
    url: `/api/users/${id}`,
    headers: withCsrf(csrf, cookie),
  });

const newProduct = async () => {
  const product = await createProduct({ price: 10, stock: 5 });
  products.push(product);
  return product;
};

const rowOf = (id: number) => asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { id } }));

const sessionOf = async (user: TestUser) => signIn(app, csrf, user);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);

  // nobody makes a root through the api; its password is unique to the run
  root = await createUser({ role: 'ROOT', password: `root-${uniqueTag()}` });
  userIds.push(root.id);
  rootCookie = accessCookie(root);

  // the avatar file lives at Cloudinary and the test environment has only made-up Cloudinary keys:
  // the call that removes it is caught here and checked, it never leaves the test
  jest.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' });

  // the test environment has no SendGrid key: every deletion logs that its mail was not sent;
  // 'deletes the account even when the mail cannot be sent' checks that line
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

describe('who may delete', () => {
  it.each(['USER', 'ADMIN'] as const)('refuses a %s and keeps the account', async (role) => {
    const actor = await newUser({ role });
    const target = await newUser({ name: 'Anna' });
    const cookie = accessCookie(actor);

    const res = await deleteUser(target.id, cookie);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(await rowOf(target.id)).toMatchObject({ email: target.email, name: 'Anna' });
  });

  it('refuses a guest', async () => {
    const target = await newUser();

    const res = await deleteUser(target.id, '');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect((await rowOf(target.id)).email).toBe(target.email);
  });
});

describe('what is refused', () => {
  it('does not let a root delete their own account', async () => {
    const res = await deleteUser(root.id, rootCookie);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ROOT_CANNOT_DELETE_SELF' });
    expect((await rowOf(root.id)).email).toBe(root.email);
  });

  it('answers 404 for a user that does not exist', async () => {
    const res = await deleteUser(2_000_000_000, rootCookie);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
  });

  it.each([
    ['letters', 'abc'],
    ['zero', '0'],
    ['a negative number', '-1'],
    ['an exponent', '1e3'],
  ])('refuses an id that is %s', async (_case, id) => {
    const res = await deleteUser(id, rootCookie);

    expect(res.statusCode).toBe(400);
  });

  // 9999999999 is a safe integer but no id of the database: a missing user, not a server failure
  it('answers with a client error for an id larger than the database holds', async () => {
    const res = await deleteUser(9_999_999_999, rootCookie);

    expect([400, 404]).toContain(res.statusCode);
  });
});

describe('what the deletion does', () => {
  it('answers with a message and empties the account of everything personal', async () => {
    const target = await newUser({
      name: 'Anna',
      locale: 'uk',
      phone: '+380501234567',
      avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v1/users/1/avatar.jpg',
      publicId: 'users/1/avatar',
    });

    const res = await deleteUser(target.id, rootCookie);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'user deleted' });
    const row = await rowOf(target.id);
    // the new address is on the domain of the site (SITE_DOMAIN): a mail that still goes to it
    // never leaves for a domain of someone else
    expect(row.email).toMatch(
      new RegExp(`^deleted\\+${target.id}\\+[a-z0-9_]+@shop\\.example\\.com$`),
    );
    expect(row.email).not.toBe(target.email);
    // the name Guest is what reviews and chats show for the account, deletedAt marks it deleted
    expect(row).toMatchObject({
      passwordHash: null,
      authProvider: 'LOCAL',
      providerSub: null,
      isVerified: false,
      name: 'Guest',
      avatarUrl: null,
      publicId: null,
      locale: null,
      phone: null,
      deletedAt: expect.any(Date),
    });
  });

  it('cuts an oauth account from its provider', async () => {
    const target = await newUser({ authProvider: 'GITHUB', providerSub: `gh-${uniqueTag()}` });

    await deleteUser(target.id, rootCookie);

    expect(await rowOf(target.id)).toMatchObject({ authProvider: 'LOCAL', providerSub: null });
  });

  it('frees the email and refuses a login with the old credentials', async () => {
    const target = await newUser();

    await deleteUser(target.id, rootCookie);

    expect(
      await asAdmin((tx) => tx.user.findUnique({ where: { email: target.email } })),
    ).toBeNull();
    const res = await logIn(app, csrf, { email: target.email, password: target.password });
    expect(res.statusCode).toBe(401);
  });

  it('closes every session of the user', async () => {
    const target = await newUser();
    const sessions: Session[] = [await sessionOf(target), await sessionOf(target)];

    await deleteUser(target.id, rootCookie);

    for (const session of sessions) {
      expect((await refreshWith(app, csrf, session.refreshToken)).statusCode).not.toBe(204);
    }
    expect(await asAdmin((tx) => tx.userToken.count({ where: { userId: target.id } }))).toBe(0);
  });

  // the access token is not stored on the server, so it cannot be taken back: a deleted user
  // keeps working until it runs out (its lifetime is the access ttl of the env) and the session
  // is not renewed after that. Accepted: the admin tells the person the account goes within that time
  describe.each(['USER', 'ADMIN'] as const)('a deleted %s', (role) => {
    it('keeps the access cookie only for the lifetime of the access token', async () => {
      const target = await newUser({ role });
      const session = await sessionOf(target);

      await deleteUser(target.id, rootCookie);

      const res = await getMe(app, sessionCookie({ accessToken: session.accessToken }));
      expect(res.statusCode).toBe(200);
      const { iat, exp } = jwt.decode(session.accessToken) as { iat: number; exp: number };
      expect(exp - iat).toBe(Number(env.JWT_ACCESS_TTL_SHORT));
    });

    // once the access cookie has run out the browser sends only the refresh cookie
    it('cannot renew the session once the access cookie is gone', async () => {
      const target = await newUser({ role });
      const session = await sessionOf(target);

      await deleteUser(target.id, rootCookie);

      const res = await getMe(app, sessionCookie({ refreshToken: session.refreshToken }));
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'LOGIN_REQUIRED' });
      const cookies = setCookies(res);
      expect(cookies.accessToken?.cleared).toBe(true);
      expect(cookies.refreshToken?.cleared).toBe(true);
    });
  });

  it('deletes an admin as well', async () => {
    const target = await newUser({ role: 'ADMIN' });

    const res = await deleteUser(target.id, rootCookie);

    expect(res.statusCode).toBe(200);
    expect((await rowOf(target.id)).email).toMatch(/^deleted\+.*@shop\.example\.com$/);
  });

  it('leaves the other users alone', async () => {
    const target = await newUser();
    const bystander = await newUser({ name: 'Boris' });

    await deleteUser(target.id, rootCookie);

    expect(await rowOf(bystander.id)).toMatchObject({ email: bystander.email, name: 'Boris' });
    const login = await logIn(app, csrf, { email: bystander.email, password: bystander.password });
    expect(login.statusCode).toBe(200);
  });

  // the root still reads the account, the person is not in it any more
  it('leaves nothing of the person in the public profile of the account', async () => {
    const target = await newUser({
      name: 'Anna',
      avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v1/x.jpg',
    });

    await deleteUser(target.id, rootCookie);

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${target.id}`,
      headers: { cookie: rootCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Guest', deletedAt: expect.any(String) });
    expect(res.json()).not.toHaveProperty('avatarUrls');
  });
});

describe('what happens around the account', () => {
  const orderOf = (id: number) => asAdmin((tx) => tx.order.findUnique({ where: { id } }));
  const productOf = (id: number) =>
    asAdmin((tx) =>
      tx.product.findUniqueOrThrow({ where: { id }, select: { stock: true, reservedStock: true } }),
    );

  it('cancels an order waiting for payment and gives its stock back', async () => {
    const target = await newUser();
    const product = await newProduct();
    const orderId = await placeOrder(app, csrf, target, product, 'waiting', 2);
    expect(await productOf(product.id)).toEqual({ stock: 5, reservedStock: 2 });

    const res = await deleteUser(target.id, rootCookie);

    expect(res.statusCode).toBe(200);
    // the order is gone: a payment that still comes for it is refunded by the webhook
    expect(await orderOf(orderId)).toBeNull();
    expect(await productOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
  });

  it('removes the cart', async () => {
    const target = await newUser();
    const orderId = await placeOrder(app, csrf, target, await newProduct(), 'cart');

    await deleteUser(target.id, rootCookie);

    expect(await orderOf(orderId)).toBeNull();
  });

  it('leaves paid and shipped orders to be delivered', async () => {
    const target = await newUser();
    const product = await newProduct();
    const paidId = await placeOrder(app, csrf, target, product, 'paid');
    const shippedId = await placeOrder(app, csrf, target, product, 'shipped');

    await deleteUser(target.id, rootCookie);

    expect(await orderOf(paidId)).toMatchObject({
      userId: target.id,
      status: 'paid',
      shippingAddress: 'Test street 1, Kyiv',
    });
    expect(await orderOf(shippedId)).toMatchObject({ userId: target.id, status: 'shipped' });
    // the stock the payments took stays taken
    expect(await productOf(product.id)).toEqual({ stock: 3, reservedStock: 0 });
  });

  // the popularity of a product counts them
  it('keeps the favorites and the reviews of the account', async () => {
    const target = await newUser();
    const product = await newProduct();
    await createFavorite(target.id, product.id);
    const review = await createReview(target.id, product.id, { rating: 4, comment: 'Fine' });

    await deleteUser(target.id, rootCookie);

    expect(
      await asAdmin((tx) =>
        tx.favorite.count({ where: { userId: target.id, productId: product.id } }),
      ),
    ).toBe(1);
    expect(await asAdmin((tx) => tx.review.findUnique({ where: { id: review.id } }))).toMatchObject(
      { userId: target.id, comment: 'Fine' },
    );
  });

  // an open admin chat waits in the admin queue; nobody would answer it any more
  it.each(['admin', 'bot'] as const)(
    'closes an open %s chat of the account and keeps its messages',
    async (type) => {
      const target = await newUser();
      const chat = await createChatThread(target.id, { type });

      await deleteUser(target.id, rootCookie);

      expect(
        await asAdmin((tx) =>
          tx.chatThread.findUniqueOrThrow({
            where: { id: chat.id },
            select: {
              status: true,
              adminRequestedAt: true,
              adminUnreadSince: true,
              unreadCount: true,
            },
          }),
        ),
      ).toEqual({
        status: 'closed',
        adminRequestedAt: null,
        adminUnreadSince: null,
        unreadCount: 0,
      });
      expect(await asAdmin((tx) => tx.chatMessage.count({ where: { threadId: chat.id } }))).toBe(1);
    },
  );

  it('removes the avatar file of the account at Cloudinary', async () => {
    const destroy = jest.mocked(cloudinary.uploader.destroy);
    destroy.mockClear();
    const tag = uniqueTag();
    const target = await newUser({
      avatarUrl: `https://res.cloudinary.com/demo/image/upload/v1/test/users/${tag}/avatar.jpg`,
      publicId: `test/users/${tag}/avatar`,
    });

    await deleteUser(target.id, rootCookie);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(
      `test/users/${tag}/avatar`,
      expect.objectContaining({ invalidate: true }),
    );
  });

  // dev is restored from a copy of prod: its rows point to the avatars of prod and to the shared
  // files from before the folders, which prod still shows
  it.each(['prod', 'old'])('leaves an avatar file of %s alone', async (where) => {
    const destroy = jest.mocked(cloudinary.uploader.destroy);
    destroy.mockClear();
    const tag = uniqueTag();
    const publicId = where === 'prod' ? `prod/users/${tag}/avatar` : `users/${tag}/avatar`;
    const target = await newUser({
      avatarUrl: `https://res.cloudinary.com/demo/image/upload/v1/${publicId}.jpg`,
      publicId,
    });

    const res = await deleteUser(target.id, rootCookie);

    expect(res.statusCode).toBe(200);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('asks Cloudinary nothing for an account without an avatar', async () => {
    const destroy = jest.mocked(cloudinary.uploader.destroy);
    destroy.mockClear();
    const target = await newUser();

    await deleteUser(target.id, rootCookie);

    expect(destroy).not.toHaveBeenCalled();
  });

  // the test environment has no SendGrid key, so every mail of a deletion fails here:
  // the account is deleted all the same, the failure only goes to the log
  it('deletes the account even when the mail cannot be sent', async () => {
    const target = await newUser();
    await placeOrder(app, csrf, target, await newProduct(), 'paid');

    const res = await deleteUser(target.id, rootCookie);

    expect(res.statusCode).toBe(200);
    expect((await rowOf(target.id)).email).toMatch(/^deleted\+/);
    // the failed mail goes to the log with the id of the account, never with its address
    const [logged] = takeLogs({ msg: 'account deleted mail was not sent' });
    expect(logged).toMatchObject({ userId: target.id });
    expect(JSON.stringify(logged)).not.toContain(target.email);
  });

  itWithMail(
    'mails the old address with the orders still on their way and the cancelled ones',
    async () => {
      const mails = watchMail();
      const target = await newUser({ name: 'Anna' });
      const product = await newProduct();
      const paidId = await placeOrder(app, csrf, target, product, 'paid');
      const waitingId = await placeOrder(app, csrf, target, product, 'waiting');

      await deleteUser(target.id, rootCookie);

      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ to: [target.email], sandbox: true });
      expect(mails[0]!.subject).toBe('Cartlify — Your account is deleted');
      expect(mails[0]!.text).toContain(`Order #${paidId}, €10.00: paid, it will be shipped`);
      // no payment page was opened for it, so nothing is known for sure about a payment
      expect(mails[0]!.text).toContain(
        `Order #${waitingId}, €10.00: cancelled; if you paid for it, the payment is refunded`,
      );
    },
  );
});

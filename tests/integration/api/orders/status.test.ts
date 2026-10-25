import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { refuseMail, watchMail, type SentMail } from '../../../helpers/mail.js';
import {
  orderRowOf,
  placeOrder,
  placeUnconfirmedOrder,
  shippingData,
} from '../../../helpers/orders.js';

// PATCH /api/orders/:orderId/status: an admin moves a paid order along its delivery, paid to
// shipped to delivered. A delivered order mails the buyer unless the account is deleted. A cancel
// returns money and stock, it is a route of its own

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const newProduct = async () => {
  const product = await createProduct({ price: 10, stock: 5 });
  products.push(product);
  return product;
};

const setStatus = (actor: TestUser, orderId: number | string, status: string) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/status`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: { status },
  });

const markDelivered = (orderId: number) =>
  asAdmin((tx) => tx.order.update({ where: { id: orderId }, data: { status: 'delivered' } }));

// a mail the app tries reaches the SendGrid mock, a failed one is logged: no mail and no line
// mean no mail was tried
const MAIL_FAILED = {
  shipped: 'order shipped mail was not sent',
  delivered: 'order delivered mail was not sent',
} as const;

const expectNoMailTried = (mails: SentMail[]) => {
  expect(mails).toEqual([]);
  expect(takeLogs({ msg: MAIL_FAILED.shipped })).toEqual([]);
  expect(takeLogs({ msg: MAIL_FAILED.delivered })).toEqual([]);
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('PATCH /api/orders/:orderId/status', () => {
  it('ships a paid order and answers with who to ship it to', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: orderId, status: 'shipped', ...shippingData });
    expect(res.json()).not.toHaveProperty('paymentId');
    expect(res.json()).not.toHaveProperty('paymentProvider');
    expect((await orderRowOf(orderId)).status).toBe('shipped');
  });

  it('marks a shipped order delivered', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'shipped');

    const res = await setStatus(admin, orderId, 'delivered');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'delivered' });
  });

  it('lets root move an order as well', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');

    const res = await setStatus(await newUser({ role: 'ROOT' }), orderId, 'shipped');

    expect(res.statusCode).toBe(200);
  });

  it('refuses a cancel here and keeps the order paid', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');

    const res = await setStatus(admin, orderId, 'cancelled');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect((await orderRowOf(orderId)).status).toBe('paid');
  });

  it.each(['pending', 'waiting', 'unconfirmed', 'paid'])(
    'refuses the status %s, an admin does not set it',
    async (status) => {
      const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');

      const res = await setStatus(admin, orderId, status);

      expect(res.statusCode).toBe(400);
      expect((await orderRowOf(orderId)).status).toBe('paid');
    },
  );

  // the order is there, its state does not allow the step: the answer must not say "not found"
  it.each([
    ['an order waiting for its payment', 'waiting'],
    ['an unconfirmed order', 'unconfirmed'],
    ['the cart', 'cart'],
  ] as const)('refuses to ship %s as a conflict', async (_case, stage) => {
    const user = await newUser();
    const orderId =
      stage === 'unconfirmed'
        ? await placeUnconfirmedOrder(app, csrf, user, await newProduct())
        : await placeOrder(app, csrf, user, await newProduct(), stage);
    const before = (await orderRowOf(orderId)).status;

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
      details: { status: before, requested: 'shipped' },
    });
    expect((await orderRowOf(orderId)).status).toBe(before);
  });

  it('refuses to move a delivered order back', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'shipped');
    await markDelivered(orderId);

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
      details: { status: 'delivered', requested: 'shipped' },
    });
    expect((await orderRowOf(orderId)).status).toBe('delivered');
  });

  it('refuses to ship an order shipped already', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'shipped');

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
      details: { status: 'shipped', requested: 'shipped' },
    });
  });

  it('answers 404 for an order that does not exist', async () => {
    const res = await setStatus(admin, 2_000_000_000, 'shipped');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
  });

  it('refuses a user, also the owner of the order', async () => {
    const owner = await newUser();
    const orderId = await placeOrder(app, csrf, owner, await newProduct(), 'paid');

    const res = await setStatus(owner, orderId, 'shipped');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect((await orderRowOf(orderId)).status).toBe('paid');
  });

  describe('the mails of the delivery', () => {
    // each step mails its own mail and never the other one; a paid order may be delivered straight
    // away, it gets the delivered mail
    it.each([
      ['paid', 'shipped', 'delivered'],
      ['paid', 'delivered', 'shipped'],
      ['shipped', 'delivered', 'shipped'],
    ] as const)(
      'keeps a %s order %s when its mail cannot be sent',
      async (stage, status, other) => {
        const buyer = await newUser();
        const orderId = await placeOrder(app, csrf, buyer, await newProduct(), stage);
        refuseMail();

        const res = await setStatus(admin, orderId, status);

        expect(res.statusCode).toBe(200);
        expect((await orderRowOf(orderId)).status).toBe(status);
        // the failed mail goes to the log with the id of the order, never with the address
        const logged = takeLogs({ msg: MAIL_FAILED[status] });
        expect(logged).toEqual([expect.objectContaining({ orderId })]);
        expect(JSON.stringify(logged)).not.toContain(buyer.email);
        expect(takeLogs({ msg: MAIL_FAILED[other] })).toEqual([]);
      },
    );

    // a second request for the same step must not mail the buyer twice
    it.each([
      ['shipped', 'shipped'],
      ['delivered', 'delivered'],
    ] as const)('mails nobody when the order is %s already', async (_case, status) => {
      const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'shipped');
      if (status === 'delivered') await markDelivered(orderId);
      const mails = watchMail();

      const res = await setStatus(admin, orderId, status);

      expect(res.statusCode).toBe(409);
      expectNoMailTried(mails);
    });

    it.each(['shipped', 'delivered'] as const)(
      'mails nobody when the step to %s is refused',
      async (status) => {
        const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'waiting');
        const mails = watchMail();

        const res = await setStatus(admin, orderId, status);

        expect(res.statusCode).toBe(409);
        expectNoMailTried(mails);
      },
    );

    // the address of a deleted account is not the person's any more
    it.each([
      ['paid', 'shipped'],
      ['shipped', 'delivered'],
    ] as const)(
      'moves a %s order of a deleted account to %s and mails nobody',
      async (stage, status) => {
        const buyer = await newUser();
        const orderId = await placeOrder(app, csrf, buyer, await newProduct(), stage);
        const deleted = await app.inject({
          method: 'DELETE',
          url: `/api/users/${buyer.id}`,
          headers: withCsrf(csrf, accessCookie(root)),
        });
        expect(deleted.statusCode).toBe(200);
        const mails = watchMail();

        const res = await setStatus(admin, orderId, status);

        expect(res.statusCode).toBe(200);
        expect((await orderRowOf(orderId)).status).toBe(status);
        expectNoMailTried(mails);
      },
    );

    it('mails the buyer that the order is shipped, where and to whom', async () => {
      const buyer = await newUser({ name: 'Anna' });
      const orderId = await placeOrder(app, csrf, buyer, await newProduct(), 'paid');
      const mails = watchMail();

      await setStatus(admin, orderId, 'shipped');

      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ to: [buyer.email], accepted: true });
      expect(mails[0]!.subject).toBe(`Cartlify — Order #${orderId} is shipped`);
      expect(mails[0]!.text).toContain(`Shipping to: ${shippingData.shippingAddress}`);
      expect(mails[0]!.text).toContain('Recipient: Anna Koval, +380501234567');
      expect(mails[0]!.text).toContain(`https://shop.example.com/orders/${orderId}`);
      expect(mails[0]!.html).toContain('Hi Anna,');
    });

    it('mails the buyer that the order is delivered, where and to whom', async () => {
      const buyer = await newUser({ name: 'Anna' });
      const orderId = await placeOrder(app, csrf, buyer, await newProduct(), 'shipped');
      const mails = watchMail();

      await setStatus(admin, orderId, 'delivered');

      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ to: [buyer.email], accepted: true });
      expect(mails[0]!.subject).toBe(`Cartlify — Order #${orderId} is delivered`);
      expect(mails[0]!.text).toContain(`Delivered to: ${shippingData.shippingAddress}`);
      expect(mails[0]!.text).toContain('Recipient: Anna Koval, +380501234567');
      expect(mails[0]!.text).toContain(`https://shop.example.com/orders/${orderId}`);
      expect(mails[0]!.html).toContain('Hi Anna,');
    });
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import stripe from '@config/stripe.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { allowLogs, takeLogs } from '../../../helpers/logs.js';
import { itWithMail, watchMail } from '../../../helpers/mail.js';
import {
  orderRowOf,
  placeOrder,
  placeUnconfirmedOrder,
  shippingData,
} from '../../../helpers/orders.js';

// POST /api/orders/:orderId/cancel: an admin cancels a paid or shipped order, for example one that
// cannot be delivered. The payment is refunded in full, the stock comes back, the buyer gets a mail
// and the admin gets how to reach the buyer, also a deleted one. A delivered order stays.
// The test environment has only a made-up Stripe key, so the answers of Stripe are given here;
// with a test key the refund goes to Stripe for real

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

const createRefund = jest.spyOn(stripe.refunds, 'create');

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

const cancel = (actor: TestUser, orderId: number | string) =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/cancel`,
    headers: withCsrf(csrf, accessCookie(actor)),
  });

const auditOf = (orderId: number) =>
  asAdmin((tx) => tx.adminAuditLog.findMany({ where: { entityType: 'order', entityId: orderId } }));

const markDelivered = (orderId: number) =>
  asAdmin((tx) => tx.order.update({ where: { id: orderId }, data: { status: 'delivered' } }));

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });

  // the test environment has no SendGrid key: every cancel logs that its mail was not sent, and so
  // does the deletion of an account; 'keeps the cancel when its mail cannot be sent' checks the line
  allowLogs({ msg: 'order cancelled mail was not sent', reason: 'SENDGRID_API_KEY_REQUIRED' });
  allowLogs({ msg: 'account deleted mail was not sent', reason: 'SENDGRID_API_KEY_REQUIRED' });
});

// Stripe refunds the payment; a test that expects no refund leaves the default, a refund call
// then fails the way an unexpected call should
beforeEach(() => {
  createRefund
    .mockReset()
    .mockRejectedValue(new Error('a Stripe call the test did not expect') as never);
});

afterAll(async () => {
  jest.restoreAllMocks();
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('POST /api/orders/:orderId/cancel', () => {
  it('cancels a paid order, refunds the payment in full and returns the stock', async () => {
    const buyer = await newUser();
    const product = await newProduct();
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 2);
    createRefund.mockResolvedValue({ id: 're_test_1' } as never);

    const res = await cancel(admin, orderId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: orderId, status: 'cancelled', total: 20 });
    expect(createRefund).toHaveBeenCalledTimes(1);
    // the whole payment: no amount, so Stripe returns everything it took
    expect(createRefund.mock.calls[0]![0]).toMatchObject({ payment_intent: `pi_test_${orderId}` });
    expect(createRefund.mock.calls[0]![0]).not.toHaveProperty('amount');
    expect((await orderRowOf(orderId)).status).toBe('cancelled');
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
  });

  it('cancels a shipped order the same way, a parcel may not reach the buyer', async () => {
    const product = await newProduct();
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'shipped');
    createRefund.mockResolvedValue({ id: 're_test_2' } as never);

    const res = await cancel(admin, orderId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'cancelled' });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
  });

  it('answers the admin how to reach the buyer', async () => {
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, await newProduct(), 'paid');
    createRefund.mockResolvedValue({ id: 're_test_3' } as never);

    const res = await cancel(admin, orderId);

    expect(res.json()).toMatchObject({
      ...shippingData,
      user: { id: buyer.id, deleted: false, email: buyer.email },
    });
    expect(res.json()).not.toHaveProperty('paymentIntentId');
  });

  it('keeps the cancel and the refund in the audit log', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');
    createRefund.mockResolvedValue({ id: 're_test_4' } as never);

    await cancel(admin, orderId);

    const records = await auditOf(orderId);
    expect(records).toEqual([
      expect.objectContaining({ actorId: admin.id, action: 'ORDER_STATUS_CHANGE' }),
    ]);
    expect(records[0]!.meta).toEqual(
      expect.arrayContaining([
        { field: 'status', old: 'paid', new: 'cancelled' },
        expect.objectContaining({
          field: 'refund',
          new: expect.objectContaining({
            paymentIntentId: `pi_test_${orderId}`,
            refundId: 're_test_4',
          }),
        }),
      ]),
    );
  });

  it('lets root cancel as well', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');
    createRefund.mockResolvedValue({ id: 're_test_5' } as never);

    const res = await cancel(root, orderId);

    expect(res.statusCode).toBe(200);
  });

  // the person is gone, the order still holds where it was going and who to call
  it('cancels an order of a deleted account and gives the contacts the order holds', async () => {
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, await newProduct(), 'paid');
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/users/${buyer.id}`,
      headers: withCsrf(csrf, accessCookie(root)),
    });
    expect(deleted.statusCode).toBe(200);
    createRefund.mockResolvedValue({ id: 're_test_6' } as never);

    const res = await cancel(admin, orderId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'cancelled',
      ...shippingData,
      user: { id: buyer.id, deleted: true },
    });
    expect(res.json().user).not.toHaveProperty('email');
  });

  it('changes nothing when Stripe refuses the refund', async () => {
    const product = await newProduct();
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid');
    createRefund.mockRejectedValue(
      Object.assign(new Error('refund refused'), { type: 'StripeAPIError' }) as never,
    );

    const res = await cancel(admin, orderId);

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    expect((await orderRowOf(orderId)).status).toBe('paid');
    expect(await stockOf(product.id)).toEqual({ stock: 4, reservedStock: 0 });
    expect(await auditOf(orderId)).toEqual([]);
    // the reason stays in the log of the server, the admin gets the plain server error
    expect(takeLogs({ msg: 'request failed', reason: 'STRIPE_REFUND_FAILED' })).toHaveLength(1);
  });

  it('keeps the cancel when its mail cannot be sent', async () => {
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, await newProduct(), 'paid');
    createRefund.mockResolvedValue({ id: 're_test_11' } as never);

    const res = await cancel(admin, orderId);

    expect(res.statusCode).toBe(200);
    expect((await orderRowOf(orderId)).status).toBe('cancelled');
    // the failed mail goes to the log with the id of the order, never with the address
    const [logged] = takeLogs({ msg: 'order cancelled mail was not sent' });
    expect(logged).toMatchObject({ orderId });
    expect(JSON.stringify(logged)).not.toContain(buyer.email);
  });

  // stripe answers the same refund for the same payment, money never goes back twice
  it('asks Stripe for the refund with one key per payment', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');
    createRefund.mockResolvedValue({ id: 're_test_7' } as never);

    await cancel(admin, orderId);

    expect(createRefund.mock.calls[0]![1]).toMatchObject({
      idempotencyKey: `refund:pi_test_${orderId}`,
    });
  });

  it('refuses a delivered order and does not refund it', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'shipped');
    await markDelivered(orderId);

    const res = await cancel(admin, orderId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ALREADY_DELIVERED' });
    expect(createRefund).not.toHaveBeenCalled();
    expect((await orderRowOf(orderId)).status).toBe('delivered');
  });

  it('refuses an order cancelled already and does not refund it again', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');
    createRefund.mockResolvedValue({ id: 're_test_8' } as never);
    await cancel(admin, orderId);
    createRefund.mockClear();

    const res = await cancel(admin, orderId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ALREADY_CANCELLED' });
    expect(createRefund).not.toHaveBeenCalled();
  });

  it.each([
    ['an order waiting for its payment', 'waiting'],
    ['an unconfirmed order', 'unconfirmed'],
    ['the cart', 'cart'],
  ] as const)('refuses %s: nothing was paid', async (_case, stage) => {
    const user = await newUser();
    const orderId =
      stage === 'unconfirmed'
        ? await placeUnconfirmedOrder(app, csrf, user, await newProduct())
        : await placeOrder(app, csrf, user, await newProduct(), stage);
    const before = (await orderRowOf(orderId)).status;

    const res = await cancel(admin, orderId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_PAID' });
    expect(createRefund).not.toHaveBeenCalled();
    expect((await orderRowOf(orderId)).status).toBe(before);
  });

  it('answers 404 for an order that does not exist', async () => {
    const res = await cancel(admin, 2_000_000_000);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
  });

  it('refuses a user, also the owner of the order', async () => {
    const owner = await newUser();
    const orderId = await placeOrder(app, csrf, owner, await newProduct(), 'paid');

    const res = await cancel(owner, orderId);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect((await orderRowOf(orderId)).status).toBe('paid');
  });

  itWithMail(
    'mails the buyer that the order is cancelled and the money is coming back',
    async () => {
      const mails = watchMail();
      const buyer = await newUser({ name: 'Anna' });
      const orderId = await placeOrder(app, csrf, buyer, await newProduct(), 'paid');
      createRefund.mockResolvedValue({ id: 're_test_9' } as never);

      await cancel(admin, orderId);

      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ to: [buyer.email], sandbox: true });
      expect(mails[0]!.subject).toBe(`Cartlify — Order #${orderId} is cancelled`);
      expect(mails[0]!.text).toContain('The payment of €10.00 is refunded in full');
    },
  );

  itWithMail('mails nobody when the account of the buyer is deleted', async () => {
    const mails = watchMail();
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, await newProduct(), 'paid');
    await app.inject({
      method: 'DELETE',
      url: `/api/users/${buyer.id}`,
      headers: withCsrf(csrf, accessCookie(root)),
    });
    mails.length = 0;
    createRefund.mockResolvedValue({ id: 're_test_10' } as never);

    await cancel(admin, orderId);

    expect(mails).toEqual([]);
  });
});

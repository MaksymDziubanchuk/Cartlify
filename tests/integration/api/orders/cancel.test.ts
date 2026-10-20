import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

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
import { placePaidOrder } from '../../../helpers/payments.js';
import {
  describeWithStripe,
  refundsOf,
  stripeRequestsDuring,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';

// POST /api/orders/:orderId/cancel: an admin cancels a paid or shipped order, for example one that
// cannot be delivered. The payment is refunded in full, the stock comes back, the buyer gets a mail
// and the admin gets how to reach the buyer, also a deleted one. A delivered order stays.
// The payments are real ones of the Stripe test sandbox (a test card), the refund goes to Stripe
// for real; Stripe out of reach is a real failed connection

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

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

const paidOrder = async (
  buyer?: TestUser,
  opts: Parameters<typeof placePaidOrder>[4] = {},
): Promise<{ orderId: number; paymentId: string; product: TestProduct }> => {
  const product = await newProduct();
  const paid = await placePaidOrder(app, csrf, buyer ?? (await newUser()), product, opts);
  return { ...paid, product };
};

const cancel = (actor: TestUser, orderId: number | string) =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/cancel`,
    headers: withCsrf(csrf, accessCookie(actor)),
  });

// what the cancel asked of Stripe, and its answer
async function cancelWatchingStripe(actor: TestUser, orderId: number) {
  let res: Response | undefined;
  const requests = await stripeRequestsDuring(async () => {
    res = await cancel(actor, orderId);
  });
  return { res: res!, requests };
}

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

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('POST /api/orders/:orderId/cancel', () => {
  describeWithStripe('a paid order', () => {
    it('cancels a paid order, refunds the payment in full and returns the stock', async () => {
      const { orderId, paymentId, product } = await paidOrder(undefined, { quantity: 2 });

      const res = await cancel(admin, orderId);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: orderId, status: 'cancelled', total: 20 });
      // the whole payment goes back
      expect(await refundsOf(paymentId)).toEqual([
        expect.objectContaining({ amount: 2000, currency: 'eur' }),
      ]);
      expect((await orderRowOf(orderId)).status).toBe('cancelled');
      expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
    });

    it('cancels a shipped order the same way, a parcel may not reach the buyer', async () => {
      const { orderId, paymentId, product } = await paidOrder(undefined, { stage: 'shipped' });

      const res = await cancel(admin, orderId);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'cancelled' });
      expect(await refundsOf(paymentId)).toHaveLength(1);
      expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
    });

    it('answers the admin how to reach the buyer', async () => {
      const buyer = await newUser();
      const { orderId } = await paidOrder(buyer);

      const res = await cancel(admin, orderId);

      expect(res.json()).toMatchObject({
        ...shippingData,
        user: { id: buyer.id, deleted: false, email: buyer.email },
      });
      expect(res.json()).not.toHaveProperty('paymentId');
      expect(res.json()).not.toHaveProperty('paymentProvider');
    });

    it('keeps the cancel and the refund in the audit log', async () => {
      const { orderId, paymentId } = await paidOrder();

      await cancel(admin, orderId);

      const [refund] = await refundsOf(paymentId);
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
              provider: 'stripe',
              paymentId,
              refundId: refund!.id,
            }),
          }),
        ]),
      );
    });

    it('lets root cancel as well', async () => {
      const { orderId } = await paidOrder();

      const res = await cancel(root, orderId);

      expect(res.statusCode).toBe(200);
    });

    // the person is gone, the order still holds where it was going and who to call
    it('cancels an order of a deleted account and gives the contacts the order holds', async () => {
      const buyer = await newUser();
      const { orderId } = await paidOrder(buyer);
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/users/${buyer.id}`,
        headers: withCsrf(csrf, accessCookie(root)),
      });
      expect(deleted.statusCode).toBe(200);

      const res = await cancel(admin, orderId);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'cancelled',
        ...shippingData,
        user: { id: buyer.id, deleted: true },
      });
      expect(res.json().user).not.toHaveProperty('email');
    });

    it('keeps the cancel when its mail cannot be sent', async () => {
      const buyer = await newUser();
      const { orderId } = await paidOrder(buyer);

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
      const { orderId, paymentId } = await paidOrder();

      const { requests } = await cancelWatchingStripe(admin, orderId);

      expect(requests).toEqual([
        expect.objectContaining({
          method: 'POST',
          path: '/v1/refunds',
          idempotency_key: `refund:${paymentId}`,
        }),
      ]);
    });

    it('changes nothing when Stripe cannot be reached', async () => {
      const { orderId, paymentId, product } = await paidOrder();

      const res = await withStripeOutOfReach(() => cancel(admin, orderId));

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ errorCode: 'INTERNAL_ERROR' });
      expect((await orderRowOf(orderId)).status).toBe('paid');
      expect(await stockOf(product.id)).toEqual({ stock: 4, reservedStock: 0 });
      expect(await auditOf(orderId)).toEqual([]);
      expect(await refundsOf(paymentId)).toEqual([]);
      // the reason stays in the log of the server, the admin gets the plain server error
      expect(takeLogs({ msg: 'request failed', reason: 'STRIPE_REFUND_FAILED' })).toHaveLength(1);
    });

    // an order paid with a payment Stripe does not know: Stripe refuses the refund for real
    it('changes nothing when Stripe refuses the refund', async () => {
      const product = await newProduct();
      const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid');

      const res = await cancel(admin, orderId);

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ errorCode: 'INTERNAL_ERROR' });
      expect((await orderRowOf(orderId)).status).toBe('paid');
      expect(await stockOf(product.id)).toEqual({ stock: 4, reservedStock: 0 });
      expect(await auditOf(orderId)).toEqual([]);
      expect(takeLogs({ msg: 'request failed', reason: 'STRIPE_REFUND_FAILED' })).toHaveLength(1);
    });

    it('refuses a delivered order and does not refund it', async () => {
      const { orderId, paymentId } = await paidOrder(undefined, { stage: 'shipped' });
      await markDelivered(orderId);

      const { res, requests } = await cancelWatchingStripe(admin, orderId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_ALREADY_DELIVERED' });
      expect(requests).toEqual([]);
      expect(await refundsOf(paymentId)).toEqual([]);
      expect((await orderRowOf(orderId)).status).toBe('delivered');
    });

    it('refuses an order cancelled already and does not refund it again', async () => {
      const { orderId, paymentId } = await paidOrder();
      await cancel(admin, orderId);

      const { res, requests } = await cancelWatchingStripe(admin, orderId);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'ORDER_ALREADY_CANCELLED' });
      expect(requests).toEqual([]);
      expect(await refundsOf(paymentId)).toHaveLength(1);
    });

    itWithMail(
      'mails the buyer that the order is cancelled and the money is coming back',
      async () => {
        const mails = watchMail();
        const buyer = await newUser({ name: 'Anna' });
        const { orderId } = await paidOrder(buyer);

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
      const { orderId } = await paidOrder(buyer);
      await app.inject({
        method: 'DELETE',
        url: `/api/users/${buyer.id}`,
        headers: withCsrf(csrf, accessCookie(root)),
      });
      mails.length = 0;

      await cancel(admin, orderId);

      expect(mails).toEqual([]);
    });
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

    const { res, requests } = await cancelWatchingStripe(admin, orderId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_PAID' });
    expect(requests).toEqual([]);
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
});

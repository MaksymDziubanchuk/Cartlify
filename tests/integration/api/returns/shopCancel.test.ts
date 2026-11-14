import type { Prisma } from '@prisma/client';
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
  removeProducts,
  stockLogOf,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { placeOrderOf } from '../../../helpers/orders.js';
import { placePaidOrder } from '../../../helpers/payments.js';
import { whileLocked } from '../../../helpers/variants.js';
import {
  queueRefundOutcome,
  realStripe,
  refundsOf,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';

// the cancels of an order are statements of return: shop_cancel cancels a paid order that was not
// sent (the goods come back to the stock at once, the order is cancelled when all of it is back, the
// money goes back at once), refused is a parcel the buyer refused (it takes whatever is left of the
// order, waits for the parcel and then for the money, and cancels the order when all of it is
// done). There is no route that cancels an order by itself any more

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(admin.id, root.id, buyer.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const mockOnly = realStripe ? it.skip : it;

const post = (url: string, payload: Record<string, unknown> = {}, actor: TestUser = admin) =>
  app.inject({
    method: 'POST',
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

// an order paid by a card Stripe really took, sent or not; its product and first item
async function paidOrder(units: number, stage: 'paid' | 'shipped' = 'paid') {
  const product = await createProduct({ price: 10, stock: 30 });
  products.push(product);
  const { orderId, paymentId } = await placePaidOrder(app, csrf, buyer, product, {
    quantity: units,
    stage,
  });
  const items = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
  );
  return { orderId, paymentId, itemId: items[0]!.id, product };
}

const cancelBody = (orderId: number, itemId: number, quantity: number) => ({
  orderId,
  items: [{ orderItemId: itemId, quantity }],
  basis: 'other',
  reason: 'shop_cancel',
  description: 'We cannot deliver it.',
});

const statusOf = async (orderId: number) =>
  asAdmin((tx) =>
    tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, cancelledAt: true, returnStatus: true },
    }),
  );

describe('shop_cancel: the shop cancels a paid order', () => {
  it('puts the goods back, cancels the order, gives all the money back through Stripe and mails the buyer', async () => {
    const { orderId, paymentId, itemId, product } = await paidOrder(3);
    const before = await stockOf(product);
    const mails = watchMail();

    const res = await post('/api/returns', cancelBody(orderId, itemId, 3));

    expect(res.statusCode).toBe(201);
    const card = res.json();
    expect(card).toMatchObject({
      basis: 'other',
      reason: 'shop_cancel',
      closedAt: expect.any(String),
      order: { status: 'cancelled', returnStatus: 'full' },
      items: [
        expect.objectContaining({
          quantity: 3,
          goods: 'to_stock',
          money: 'refunded',
          amount: 30,
          moneyLogId: expect.any(Number),
        }),
      ],
      // the transfer: the goods and the delivery of the order, sent, with the id Stripe gave
      money: expect.arrayContaining([
        expect.objectContaining({
          event: 'money.refund',
          part: 'goods',
          amount: -30,
          state: 'sent',
          refundId: expect.stringMatching(/^re_/),
        }),
      ]),
    });
    // the stock is back, with the line of the stock log in the name of the admin
    expect((await stockOf(product)).stock).toBe(before.stock + 3);
    expect(
      (await stockLogOf({ orderId })).filter((line) => line.event === 'stock.return'),
    ).toHaveLength(1);
    // the whole payment went back
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 3000 })]);
    expect(await statusOf(orderId)).toMatchObject({
      status: 'cancelled',
      cancelledAt: expect.any(Date),
      returnStatus: 'full',
    });
    // the log: the statement and the money
    const events = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId },
        select: { event: true, actorId: true },
        orderBy: { id: 'asc' },
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        { event: 'return.create', actorId: admin.id },
        { event: 'return.refund', actorId: admin.id },
      ]),
    );
    // two mails: the shop registered the return, and the return is closed with the money back
    const own = mails.filter((mail) => mail.to.includes(buyer.email));
    expect(own).toHaveLength(2);
    expect(own.some((mail) => mail.subject.includes('is closed'))).toBe(true);
    expect(own.some((mail) => mail.subject.includes('registered'))).toBe(true);
  });

  it('cancels a part of the order: those units go back, their money goes back, the order stays paid', async () => {
    const { orderId, paymentId, itemId, product } = await paidOrder(3);
    const before = await stockOf(product);

    const res = await post('/api/returns', cancelBody(orderId, itemId, 1));

    expect(res.statusCode).toBe(201);
    expect(res.json().order).toMatchObject({ status: 'paid', returnStatus: 'partial' });
    expect((await stockOf(product)).stock).toBe(before.stock + 1);
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 1000 })]);
    expect(await statusOf(orderId)).toMatchObject({ status: 'paid', cancelledAt: null });
  });

  it('cancels the order for good: it can no longer be sent', async () => {
    const { orderId, itemId } = await paidOrder(1);
    await post('/api/returns', cancelBody(orderId, itemId, 1));

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { status: 'shipped' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_STATUS_TRANSITION_INVALID' });
    expect((await statusOf(orderId)).status).toBe('cancelled');
  });

  it('shows the buyer a cancelled order with its money back', async () => {
    const { orderId, itemId } = await paidOrder(1);
    await post('/api/returns', cancelBody(orderId, itemId, 1));

    const res = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(buyer) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'cancelled', returnStatus: 'full' });
  });

  mockOnly(
    'cancels the order and puts the goods back even when Stripe refuses: the card says why',
    async () => {
      const { orderId, itemId, product } = await paidOrder(1);
      const before = await stockOf(product);
      queueRefundOutcome({ status: 'failed', reason: 'insufficient_funds' });

      const res = await post('/api/returns', cancelBody(orderId, itemId, 1));

      expect(res.statusCode).toBe(201);
      expect(res.json().order.status).toBe('cancelled');
      expect(res.json().items[0]).toMatchObject({
        goods: 'to_stock',
        money: 'failed',
        refundFailure: { code: 'shop_balance' },
      });
      expect((await stockOf(product)).stock).toBe(before.stock + 1);
      // the admin tops the balance up and gives the money back
      const again = await post(`/api/returns/${res.json().id}/refund`);
      expect(again.statusCode).toBe(200);
      expect(again.json().items[0]).toMatchObject({ money: 'refunded' });
    },
  );

  it('cancels the order and leaves the money pending when Stripe cannot be reached', async () => {
    const { orderId, itemId } = await paidOrder(1);

    const res = await withStripeOutOfReach(() =>
      post('/api/returns', cancelBody(orderId, itemId, 1)),
    );

    expect(res.statusCode).toBe(201);
    expect(res.json().order.status).toBe('cancelled');
    expect(res.json().items[0]).toMatchObject({ goods: 'to_stock', money: 'pending' });
    expect(
      (await stockLogOf({ orderId })).filter((line) => line.event === 'stock.return'),
    ).toHaveLength(1);
  });

  it('is done by a root as by an admin, in the name of the root', async () => {
    const { orderId, itemId } = await paidOrder(1);

    const res = await post('/api/returns', cancelBody(orderId, itemId, 1), root);

    expect(res.statusCode).toBe(201);
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.create' },
        select: { actorId: true, meta: true },
      }),
    );
    expect(lines).toEqual([
      expect.objectContaining({
        actorId: root.id,
        // the log says the order was cancelled by it
        meta: expect.arrayContaining([{ field: 'status', old: 'paid', new: 'cancelled' }]),
      }),
    ]);
  });

  it('lets one of two requests at once win: the cancel or the step to shipped, never both', async () => {
    const { orderId, itemId, product } = await paidOrder(1);
    const before = await stockOf(product);

    const [cancel, ship] = await whileLocked(
      async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`select id from cartlify.orders where id = ${orderId}::int for update`;
      },
      () =>
        Promise.all([
          post('/api/returns', cancelBody(orderId, itemId, 1)),
          app.inject({
            method: 'PATCH',
            url: `/api/orders/${orderId}/status`,
            headers: withCsrf(csrf, accessCookie(admin)),
            payload: { status: 'shipped' },
          }),
        ]),
      { waiters: 2 },
    );

    const cancelled = cancel!.statusCode === 201;
    // the one that came second is refused, and the order is what the first made it
    expect(cancelled ? ship!.statusCode : cancel!.statusCode).toBe(409);
    if (!cancelled) expect(ship!.statusCode).toBe(200);
    expect((await statusOf(orderId)).status).toBe(cancelled ? 'cancelled' : 'shipped');
    expect((await stockOf(product)).stock).toBe(before.stock + (cancelled ? 1 : 0));
  });

  it('is refused for a delivered order, an order that waits for its payment and an order cancelled already, with no money asked of Stripe', async () => {
    const delivered = await paidOrder(1, 'shipped');
    await asAdmin((tx) =>
      tx.order.update({ where: { id: delivered.orderId }, data: { status: 'delivered' } }),
    );
    const waiting = await createProduct({ price: 10, stock: 5 });
    products.push(waiting);
    const waitingId = await placeOrderOf(
      app,
      csrf,
      buyer,
      [{ item: waiting, quantity: 1 }],
      'waiting',
    );
    const [waitingItem] = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId: waitingId }, select: { id: true } }),
    );
    const done = await paidOrder(1);
    const first = await post('/api/returns', cancelBody(done.orderId, done.itemId, 1));

    const results = [
      await post('/api/returns', cancelBody(delivered.orderId, delivered.itemId, 1)),
      await post('/api/returns', cancelBody(waitingId, waitingItem!.id, 1)),
      await post('/api/returns', cancelBody(done.orderId, done.itemId, 1)),
    ];

    expect(first.statusCode).toBe(201);
    expect(results.map((res) => [res.statusCode, res.json().errorCode])).toEqual([
      [409, 'RETURN_ORDER_NOT_RETURNABLE'],
      [409, 'RETURN_ORDER_NOT_RETURNABLE'],
      [409, 'RETURN_ORDER_NOT_RETURNABLE'],
    ]);
    expect(await refundsOf(delivered.paymentId)).toEqual([]);
    // the one refund of the first cancel, and no second
    expect(await refundsOf(done.paymentId)).toHaveLength(1);
  });

  it('cancels the order of a payment Stripe does not know and shows the money as failed, with the failure', async () => {
    const product = await createProduct({ price: 10, stock: 5 });
    products.push(product);
    // a made-up payment id: Stripe has no such payment
    const orderId = await placeOrderOf(app, csrf, buyer, [{ item: product, quantity: 1 }], 'paid');
    const [item] = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
    );

    const res = await post('/api/returns', cancelBody(orderId, item!.id, 1));

    expect(res.statusCode).toBe(201);
    expect(res.json().order.status).toBe('cancelled');
    expect(res.json().items[0]).toMatchObject({
      goods: 'to_stock',
      money: 'failed',
      refundFailure: { code: 'unknown', text: expect.stringContaining('No such payment_intent') },
    });
  });

  it.each([
    [
      'a basis other than other (400 RETURN_REASON_INVALID)',
      { basis: 'withdrawal' },
      'paid' as const,
      400,
      'RETURN_REASON_INVALID',
    ],
    [
      'an order that was sent (409 RETURN_ORDER_NOT_RETURNABLE)',
      {},
      'shipped' as const,
      409,
      'RETURN_ORDER_NOT_RETURNABLE',
    ],
  ])('is refused for %s', async (_what, extra, stage, status, code) => {
    const { orderId, itemId } = await paidOrder(1, stage);

    const res = await post('/api/returns', { ...cancelBody(orderId, itemId, 1), ...extra });

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({ status, code });
  });
});

describe('refused: the buyer refused the parcel', () => {
  // the moment of the refusal is the admin's: here the time of the payment, the first there can be
  const refusal = async (orderId: number, itemId: number, quantity: number, extra = {}) => {
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );

    return {
      orderId,
      items: [{ orderItemId: itemId, quantity }],
      basis: 'withdrawal',
      reason: 'refused',
      statedAt: paidAt!.toISOString(),
      ...extra,
    };
  };

  it('takes whatever is left of the order, whatever part was named, and moves no stock and no money', async () => {
    const { orderId, paymentId, itemId, product } = await paidOrder(3, 'shipped');
    const before = await stockOf(product);

    const res = await post('/api/returns', await refusal(orderId, itemId, 1));

    expect(res.statusCode).toBe(201);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        quantity: 3,
        goods: 'expected',
        money: 'not_refunded',
        amount: 30,
      }),
    ]);
    expect(res.json().order).toMatchObject({ status: 'shipped', returnStatus: 'open' });
    expect((await stockOf(product)).stock).toBe(before.stock);
    expect(await refundsOf(paymentId)).toEqual([]);
  });

  it('cancels the order once the parcel is back and all the money with it: not before', async () => {
    const { orderId, paymentId, itemId } = await paidOrder(2, 'shipped');
    const made = await post('/api/returns', await refusal(orderId, itemId, 2));
    const returnId: number = made.json().id;
    const rowId: number = made.json().items[0].id;

    const back = await post(`/api/returns/${returnId}/receive`, {
      parcel: { buyerPaid: 0 },
      results: [{ itemId: rowId, quantity: 2, goods: 'to_stock' }],
    });
    const stillShipped = await statusOf(orderId);
    const paid = await post(`/api/returns/${returnId}/refund`);

    expect(back.statusCode).toBe(200);
    expect(stillShipped.status).toBe('shipped');
    expect(paid.statusCode).toBe(200);
    expect(paid.json().order).toMatchObject({ status: 'cancelled', returnStatus: 'full' });
    expect(await refundsOf(paymentId)).toEqual([expect.objectContaining({ amount: 2000 })]);
  });

  it('wants the moment of the refusal (400 RETURN_STATED_AT_INVALID) and refuses a delivered order (409)', async () => {
    const sent = await paidOrder(1, 'shipped');
    const delivered = await paidOrder(1, 'shipped');
    await asAdmin((tx) =>
      tx.order.update({ where: { id: delivered.orderId }, data: { status: 'delivered' } }),
    );
    const { statedAt: _gone, ...without } = await refusal(sent.orderId, sent.itemId, 1);

    const noMoment = await post('/api/returns', without);
    const late = await post('/api/returns', await refusal(delivered.orderId, delivered.itemId, 1));

    expect([noMoment.statusCode, noMoment.json().errorCode]).toEqual([
      400,
      'RETURN_STATED_AT_INVALID',
    ]);
    expect([late.statusCode, late.json().errorCode]).toEqual([409, 'RETURN_ORDER_NOT_RETURNABLE']);
  });

  it('keeps the order from becoming delivered while the parcel is on its way back (409 ORDER_HAS_OPEN_REFUSAL)', async () => {
    const { orderId, itemId } = await paidOrder(1, 'shipped');
    await post('/api/returns', await refusal(orderId, itemId, 1));

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { status: 'delivered' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_HAS_OPEN_REFUSAL' });
    expect((await statusOf(orderId)).status).toBe('shipped');
  });

  it.each([
    [
      'a basis other than withdrawal (400 RETURN_REASON_INVALID)',
      { basis: 'other' },
      'shipped' as const,
      400,
      'RETURN_REASON_INVALID',
    ],
    [
      'an order that was not sent (409 RETURN_ORDER_NOT_RETURNABLE)',
      {},
      'paid' as const,
      409,
      'RETURN_ORDER_NOT_RETURNABLE',
    ],
  ])('is refused for %s', async (_what, extra, stage, status, code) => {
    const { orderId, itemId } = await paidOrder(1, stage);

    const res = await post('/api/returns', await refusal(orderId, itemId, 1, extra));

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({ status, code });
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { placePaidOrderOf } from '../../helpers/payments.js';
import { journeyOf, mailTo, statementCodeIn } from '../../helpers/returnJourney.js';
import { refundsOf } from '../../helpers/stripe.js';

// The returns the shop starts (docs/return-scenarios.md, 6, 7 and 8): the cancel of a paid order,
// a parcel the buyer refused, goods taken back outside the withdrawal. The admin works from the
// card of the order and of the statement, the buyer is told by mail. The order is paid as the
// setup of the test

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

async function paidOrder(units: number) {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 20 });
  products.push(product);
  const { orderId, paymentId } = await placePaidOrderOf(app, csrf, buyer, [
    { item: product, quantity: units },
  ]);
  return { buyer, product, orderId, paymentId };
}

// the order as the card of the admin shows it: its items with their units, its sends
const orderCardOf = async (orderId: number) =>
  (await j.get(admin, `/api/orders/${orderId}`)).json() as {
    status: string;
    returnStatus: string;
    items: Array<{ id: number; quantity: number }>;
    shipments: Array<{ shippedAt: string }>;
  };

const step = async (orderId: number, status: string) =>
  expect((await j.patch(admin, `/api/orders/${orderId}/status`, { status })).statusCode).toBe(200);

describe('the returns the shop starts', () => {
  it('cancels a paid order the shop cannot send: the goods back at once, the order cancelled, the money back', async () => {
    const { buyer, product, orderId, paymentId } = await paidOrder(2);
    const before = await stockOf(product);
    const mails = watchMail();

    const card = await orderCardOf(orderId);
    const made = await j.post(admin, '/api/returns', {
      orderId,
      items: card.items.map((item) => ({ orderItemId: item.id, quantity: item.quantity })),
      basis: 'other',
      reason: 'shop_cancel',
    });

    expect(made.statusCode).toBe(201);
    expect(made.json().code).toBe(`R${orderId}-1`);
    const notice = mailTo(mails, buyer.email, `Return of order #${orderId} registered`);
    expect(statementCodeIn(notice)).toBe(`R${orderId}-1`);
    expect(mailTo(mails, buyer.email, 'is closed').text).toContain('We sent you €20.00.');
    expect(await orderCardOf(orderId)).toMatchObject({ status: 'cancelled', returnStatus: 'full' });
    expect((await stockOf(product)).stock).toBe(before.stock + 2);
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([2000]);
  });

  it('takes a parcel the buyer refused: whatever is left of the order, dated by the carrier, cancelled once back with the money', async () => {
    const { product, orderId, paymentId } = await paidOrder(2);
    await step(orderId, 'shipped');
    const card = await orderCardOf(orderId);
    const before = await stockOf(product);

    // the carrier gives the moment it was refused: here the moment it was sent, from the card
    const made = await j.post(admin, '/api/returns', {
      orderId,
      items: [{ orderItemId: card.items[0]!.id, quantity: 1 }],
      basis: 'withdrawal',
      reason: 'refused',
      statedAt: card.shipments[0]!.shippedAt,
    });
    expect(made.statusCode).toBe(201);
    // one unit named, the whole of what is left taken
    expect(made.json().items).toEqual([
      expect.objectContaining({ quantity: 2, goods: 'expected' }),
    ]);

    const returnId = made.json().id;
    expect(
      (
        await j.post(admin, `/api/returns/${returnId}/receive`, {
          results: [{ itemId: made.json().items[0].id, quantity: 2, goods: 'to_stock' }],
        })
      ).statusCode,
    ).toBe(200);
    expect((await j.post(admin, `/api/returns/${returnId}/refund`)).statusCode).toBe(200);

    expect(await orderCardOf(orderId)).toMatchObject({ status: 'cancelled', returnStatus: 'full' });
    expect((await stockOf(product)).stock).toBe(before.stock + 2);
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([2000]);
  });

  it('takes goods back outside the withdrawal, with the parcel the shop paid and its cost put right', async () => {
    const { buyer, orderId, paymentId } = await paidOrder(1);
    await step(orderId, 'shipped');
    await step(orderId, 'delivered');
    const card = await orderCardOf(orderId);
    const mails = watchMail();

    const made = await j.post(admin, '/api/returns', {
      orderId,
      items: [{ orderItemId: card.items[0]!.id, quantity: 1 }],
      basis: 'other',
      reason: 'defect',
      description: 'The lamp does not light.',
    });
    expect(made.statusCode).toBe(201);
    const returnId = made.json().id;
    expect(statementCodeIn(mailTo(mails, buyer.email, 'registered'))).toBe(`R${orderId}-1`);

    // the shop sends a label: the parcel back with its cost; the bill of the carrier puts it right
    const parcel = {
      carrier: 'DHL',
      trackingNumber: 'JD0146000555',
      cost: 4.5,
      shippedAt: made.json().statedAt,
    };
    const recorded = await j.post(admin, `/api/returns/${returnId}/shipments`, parcel);
    expect(recorded.statusCode).toBe(201);
    const shipmentId = recorded.json().shipments[0].id as number;
    const billed = await j.patch(admin, `/api/returns/${returnId}/shipments/${shipmentId}`, {
      cost: 5.2,
    });
    expect(billed.json().shipments).toEqual([
      expect.objectContaining({ id: shipmentId, cost: 5.2 }),
    ]);

    expect(
      (
        await j.post(admin, `/api/returns/${returnId}/receive`, {
          results: [{ itemId: made.json().items[0].id, quantity: 1, goods: 'written_off' }],
        })
      ).statusCode,
    ).toBe(200);
    expect((await j.post(admin, `/api/returns/${returnId}/refund`)).statusCode).toBe(200);

    // a delivered order stays delivered; what came back is its returnStatus
    expect(await orderCardOf(orderId)).toMatchObject({ status: 'delivered', returnStatus: 'full' });
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([1000]);
  });
});

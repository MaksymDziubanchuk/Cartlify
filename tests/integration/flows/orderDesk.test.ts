import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { deliveryBody, placeOrder } from '../../helpers/orders.js';
import { journeyOf, mailTo } from '../../helpers/returnJourney.js';

// The desk of the orders, each step with what its actor sees: an admin finds the paid orders of a
// buyer, puts the address right after a call of the buyer, ships both orders at once with their
// numbers, puts a wrong number right, takes an order shipped by mistake one step back and ships it
// again, then marks both delivered; the buyer reads every step in the mails and the order. The rules
// of each step are the tests of api/orders.
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Desk Buyer' });
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

type Order = { id: number; status: string; shipments: { id: number; trackingNumber: string }[] };

describe('the desk of the orders', () => {
  it('finds, puts right, ships, steps back and delivers the orders of a buyer', async () => {
    const product = await createProduct({ price: 15, stock: 5 });
    const placed = [
      await placeOrder(app, csrf, buyer, product, 'paid'),
      await placeOrder(app, csrf, buyer, product, 'paid'),
    ].sort((a, b) => a - b);
    const mails = watchMail();

    // the admin finds the paid orders of the buyer by the email
    const found = await j.get(
      admin,
      `/api/orders?q=${encodeURIComponent(buyer.email)}&status=paid`,
    );
    expect(found.statusCode).toBe(200);
    const [first, second] = (found.json().items as Order[])
      .map(({ id }) => id)
      .sort((a, b) => a - b);
    expect([first, second]).toEqual(placed);

    // the buyer calls: the first order goes to another street
    const moved = await j.patch(admin, `/api/orders/${first}/delivery`, {
      ...deliveryBody,
      address: { ...deliveryBody.address, street: 'New street', house: '7' },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().delivery.address).toMatchObject({ street: 'New street', house: '7' });

    // both go at once, each with its number; the buyer gets a mail of each
    const shipped = await j.post(admin, '/api/orders/status', {
      status: 'shipped',
      orders: [
        { orderId: first, shipment: { carrier: 'Nova Poshta', trackingNumber: '20450000000001' } },
        { orderId: second, shipment: { carrier: 'Nova Poshta', trackingNumber: '20450000000009' } },
      ],
    });
    expect(shipped.statusCode).toBe(200);
    expect((shipped.json().results as { ok: boolean }[]).every(({ ok }) => ok)).toBe(true);
    expect(mailTo(mails, buyer.email, `Order #${first} is shipped`).text).toContain(
      '20450000000001',
    );
    expect(mailTo(mails, buyer.email, `Order #${second} is shipped`).text).toContain(
      '20450000000009',
    );

    // the second number was wrong: the admin puts it right on the order
    const secondOrder = (await j.get(admin, `/api/orders/${second}`)).json() as Order;
    const fixed = await j.patch(
      admin,
      `/api/orders/${second}/shipments/${secondOrder.shipments[0]!.id}`,
      {
        trackingNumber: '20450000000002',
      },
    );
    expect(fixed.statusCode).toBe(200);
    expect((await j.get(buyer, `/api/orders/${second}`)).json().delivery.shipment).toMatchObject({
      trackingNumber: '20450000000002',
    });

    // the first one never left the shop: one step back, then shipped again
    const back = await j.post(admin, '/api/orders/status', {
      status: 'paid',
      orders: [{ orderId: first, keepShippingCost: false }],
    });
    expect(back.json().results).toEqual([
      expect.objectContaining({ orderId: first, ok: true, status: 'paid' }),
    ]);
    const again = await j.patch(admin, `/api/orders/${first}/status`, {
      status: 'shipped',
      shipment: { carrier: 'Nova Poshta', trackingNumber: '20450000000003' },
    });
    expect(again.statusCode).toBe(200);

    // both delivered; the buyer sees the period of withdrawal open
    const delivered = await j.post(admin, '/api/orders/status', {
      status: 'delivered',
      orders: [{ orderId: first }, { orderId: second }],
    });
    expect((delivered.json().results as { ok: boolean }[]).every(({ ok }) => ok)).toBe(true);
    for (const orderId of [first, second]) {
      const order = (await j.get(buyer, `/api/orders/${orderId}`)).json();
      expect(order).toMatchObject({ status: 'delivered', withdrawalOpen: true });
    }
    expect((await j.get(buyer, `/api/orders/${first}`)).json().delivery).toMatchObject({
      address: { street: 'New street' },
      shipment: { trackingNumber: '20450000000003' },
    });
  });
});

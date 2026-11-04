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
import {
  journeyOf,
  mailTo,
  statementCodeIn,
  withdrawalLinkIn,
} from '../../helpers/returnJourney.js';
import { refundsOf } from '../../helpers/stripe.js';

// The buyer withdraws from their account (docs/return-scenarios.md, 1 and 2), each step with what
// its actor sees: the buyer the page of the order and the mails, the admin the list and the cards.
// The order is paid as the setup of the test; the money goes back through Stripe (its mock, or the
// sandbox with service:stripe)

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

async function buyerWithOrder(units: number) {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 20 });
  products.push(product);
  const { orderId, paymentId } = await placePaidOrderOf(app, csrf, buyer, [
    { item: product, quantity: units },
  ]);
  return { buyer, product, orderId, paymentId };
}

describe('the buyer withdraws from their account', () => {
  it('before the order is sent: picks units on the page, the money goes back at once, the rest is still to send', async () => {
    const { buyer, product, orderId, paymentId } = await buyerWithOrder(3);
    const before = await stockOf(product);
    const mails = watchMail();

    // the page of the order: the button works and names the units free to withdraw from
    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(page.withdrawalOpen).toBe(true);
    expect(page.withdrawable).toEqual([{ orderItemId: expect.any(Number), quantity: 3 }]);
    const [free] = page.withdrawable;

    // the page asked to confirm one unit of them
    const made = await j.post(buyer, `/api/orders/${orderId}/withdrawal`, {
      items: [{ orderItemId: free.orderItemId, quantity: 1 }],
    });

    expect(made.statusCode).toBe(201);
    const statement = made.json().withdrawals[0];
    expect(statement.code).toBe(`W${orderId}-1`);
    expect(made.json().withdrawable).toEqual([{ orderItemId: free.orderItemId, quantity: 2 }]);

    // the mails name the code the page shows; the goods stay with the shop, the money went back
    const notice = mailTo(mails, buyer.email, `Withdrawal from order #${orderId}`);
    expect(statementCodeIn(notice)).toBe(statement.code);
    expect(notice.text).toContain('the goods stay with us');
    expect(mailTo(mails, buyer.email, 'is closed').text).toContain('€10.00 went back to you.');

    // the admin sees on the order what is left to send
    const card = (await j.get(admin, `/api/orders/${orderId}`)).json();
    expect(card.status).toBe('paid');
    expect(card.returnUnits.items).toEqual([
      expect.objectContaining({ quantity: 3, withShop: 1, toShip: 2 }),
    ]);

    // what came of it: the unit is on the shelf, the money of it at Stripe
    expect((await stockOf(product)).stock).toBe(before.stock + 1);
    expect((await refundsOf(paymentId)).map((refund) => [refund.amount, refund.status])).toEqual([
      [1000, 'succeeded'],
    ]);
  });

  it('after the order was sent: the parcel by the link of the mail, the money ahead of the goods, the goods in', async () => {
    const { buyer, product, orderId, paymentId } = await buyerWithOrder(2);
    expect(
      (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' })).statusCode,
    ).toBe(200);
    const before = await stockOf(product);
    const mails = watchMail();

    // the whole of the order: the button without units named
    const made = await j.post(buyer, `/api/orders/${orderId}/withdrawal`);
    expect(made.statusCode).toBe(201);

    // the notice says where and by when to send the goods, and links the page of the parcel
    const notice = mailTo(mails, buyer.email, `Withdrawal from order #${orderId}`);
    const code = statementCodeIn(notice);
    const parcel = withdrawalLinkIn(notice);
    expect(parcel.orderId).toBe(orderId);
    expect(parcel.returnId).toBe(made.json().withdrawals[0].id);

    // the buyer writes the parcel on the page of that link
    const proof = await j.post(null, '/api/withdrawals/proof', {
      orderId: parcel.orderId,
      code: parcel.code,
      returnId: parcel.returnId,
      carrier: 'DHL',
      trackingNumber: 'JD0146000123',
    });
    expect(proof.statusCode).toBe(200);

    // the admin finds the statement by the code the buyer wrote in a letter, and sees the parcel
    const found = (await j.get(admin, `/api/returns?q=${code}`)).json().items;
    expect(found).toEqual([
      expect.objectContaining({
        code,
        proof: expect.objectContaining({ providedAt: expect.any(String) }),
      }),
    ]);
    const returnId = found[0].id;

    // the parcel is on its way: the admin confirms it and the money goes ahead of the goods
    expect((await j.post(admin, `/api/returns/${returnId}/proof/confirm`)).statusCode).toBe(200);
    const paid = await j.post(admin, `/api/returns/${returnId}/refund`);
    expect(paid.statusCode).toBe(200);
    expect(paid.json().items).toEqual([
      expect.objectContaining({ goods: 'expected', money: 'refunded' }),
    ]);

    // the goods come in
    const card = (await j.get(admin, `/api/returns/${returnId}`)).json();
    const taken = await j.post(admin, `/api/returns/${returnId}/receive`, {
      results: [{ itemId: card.items[0].id, quantity: 2, goods: 'to_stock' }],
    });
    expect(taken.statusCode).toBe(200);
    expect(taken.json().closedAt).not.toBeNull();

    // the buyer sees the end, and the order is cancelled: it all came back with its money
    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(page).toMatchObject({ status: 'cancelled', returnStatus: 'full' });
    expect(page.withdrawals[0]).toMatchObject({ code, step: 'closed' });
    expect((await stockOf(product)).stock).toBe(before.stock + 2);
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([2000]);
  });

  it('writes the parcel on the page of the order in the account, and the admin sees it on the card', async () => {
    const { buyer, orderId } = await buyerWithOrder(1);
    expect(
      (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' })).statusCode,
    ).toBe(200);
    const mails = watchMail();
    const made = await j.post(buyer, `/api/orders/${orderId}/withdrawal`);
    const returnId = made.json().withdrawals[0].id as number;

    const proof = await j.post(buyer, `/api/orders/${orderId}/returns/${returnId}/proof`, {
      carrier: 'DHL',
      trackingNumber: 'JD0146000777',
    });
    expect(proof.statusCode).toBe(200);

    const code = statementCodeIn(mailTo(mails, buyer.email, `Withdrawal from order #${orderId}`));
    const [found] = (await j.get(admin, `/api/returns?q=${code}`)).json().items;
    const card = (await j.get(admin, `/api/returns/${found.id}`)).json();
    expect(card.proof).toMatchObject({ carrier: 'DHL', trackingNumber: 'JD0146000777' });
  });
});

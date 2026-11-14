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
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { placePaidOrderOf } from '../../../helpers/payments.js';
import { queueRefundOutcome, realStripe, refundsOf } from '../../../helpers/stripe.js';

// the way back the shop pays a buyer, what the receipt of the parcel says: it goes with the transfer
// that ends the money of the statement (POST /api/returns/:returnId/refund) when the payment holds
// it, and outside the app otherwise (POST /api/returns/:returnId/refund/outside, the one step for
// all a statement owes). The rules of the sums are the database's (db/returnMoney.test.ts); here the
// answers, the movements the buyer sees and the mails

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const mockOnly = realStripe ? it.skip : it;
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

const post = (url: string, payload: Record<string, unknown>, actor: TestUser = admin) =>
  app.inject({ method: 'POST', url, headers: withCsrf(csrf, accessCookie(actor)), payload });

const orderOf = async (orderId: number) =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(buyer) },
    })
  ).json();

const mailsTo = (mails: ReturnType<typeof watchMail>, subject: string) =>
  mails.filter((mail) => mail.to.includes(buyer.email) && mail.subject.includes(subject));

// a paid order of so many units at 10, a statement of an admin for one of them (the shop pays the
// way back), the unit in with the receipt of the parcel: the buyer paid the carrier 6.50 (or the
// sum named)
async function wayBackOwed(units: number, buyerPaid = 6.5) {
  const product = await createProduct({ price: 10, stock: 20 });
  products.push(product);
  const { orderId, paymentId } = await placePaidOrderOf(app, csrf, buyer, [
    { item: product, quantity: units },
  ]);
  const [item] = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
  );
  const made = await post('/api/returns', {
    orderId,
    items: [{ orderItemId: item!.id, quantity: 1 }],
    basis: 'other',
    reason: 'defect',
  });
  expect(made.statusCode).toBe(201);
  const returnId = made.json().id as number;
  const taken = await post(`/api/returns/${returnId}/receive`, {
    results: [{ itemId: made.json().items[0].id, quantity: 1, goods: 'to_stock' }],
    parcel: { buyerPaid },
  });
  expect(taken.statusCode).toBe(200);
  const { paidAt } = await asAdmin((tx) =>
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
  );
  return { orderId, paymentId, returnId, paidAt: paidAt! };
}

describe('the way back the shop pays', () => {
  it('goes with the transfer when the payment holds it: the provider sends it, the buyer sees it and is mailed it', async () => {
    const { orderId, paymentId, returnId } = await wayBackOwed(3);
    const mails = watchMail();

    const res = await post(`/api/returns/${returnId}/refund`, {});

    expect(res.statusCode).toBe(200);
    expect(res.json().money).toEqual(
      expect.arrayContaining([expect.objectContaining({ part: 'way_back', amount: -6.5 })]),
    );
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([1650]);
    expect((await orderOf(orderId)).withdrawals[0].refunds).toEqual([
      expect.objectContaining({ goods: 10, wayBack: 6.5, amount: 16.5 }),
    ]);
    const [mail] = mailsTo(mails, 'is closed');
    expect(mail!.text).toContain('€16.50');
  });

  it('goes outside the app when the payment cannot hold it: one step for all that is owed, mailed alone (409 RETURN_NOTHING_OWED after)', async () => {
    const { orderId, paymentId, returnId, paidAt } = await wayBackOwed(1);
    const sent = await post(`/api/returns/${returnId}/refund`, {});
    expect(sent.statusCode).toBe(200);
    // the payment held the unit only
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([1000]);
    const mails = watchMail();

    const outside = await post(
      `/api/returns/${returnId}/refund/outside`,
      {
        method: 'bank_transfer',
        note: 'The receipt of the carrier came by mail.',
        at: new Date(paidAt.getTime() + 1).toISOString(),
      },
      root,
    );
    const again = await post(
      `/api/returns/${returnId}/refund/outside`,
      {
        method: 'bank_transfer',
        note: 'Again.',
        at: new Date(paidAt.getTime() + 1).toISOString(),
      },
      root,
    );

    expect(outside.statusCode).toBe(200);
    expect(outside.json()).toMatchObject({ refundedTotal: 16.5 });
    const [mail] = mailsTo(mails, `We paid back the cost of sending order #${orderId} back`);
    expect(mail!.text).toContain('€6.50');
    expect((await orderOf(orderId)).withdrawals[0].refunds).toEqual([
      expect.objectContaining({ way: 'payment', goods: 10, wayBack: 0 }),
      expect.objectContaining({ way: 'outside', goods: 0, wayBack: 6.5, amount: 6.5 }),
    ]);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'RETURN_NOTHING_OWED' });
  });
});

// what the buyer paid the carrier, as the admin set it from the receipt: corrected while no money of
// the way back went, the card follows; the card warns of a sum above the order (the page shows the sum the buyer told beside the field, never in it)
describe('the sum of the receipt of the parcel', () => {
  const patch = (returnId: number, shipmentId: number, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/returns/${returnId}/shipments/${shipmentId}`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload,
    });
  const parcelOf = async (returnId: number) => {
    const card = (
      await app.inject({
        method: 'GET',
        url: `/api/returns/${returnId}`,
        headers: { cookie: accessCookie(admin) },
      })
    ).json();
    return { card, parcel: card.parcels[0] as { id: number; buyerPaid: number | null } };
  };

  it('is corrected while no money of the way back went: the card owes the new sum', async () => {
    const { returnId } = await wayBackOwed(3);
    const { parcel } = await parcelOf(returnId);

    const res = await patch(returnId, parcel.id, { buyerPaid: 4.2 });

    expect(res.statusCode).toBe(200);
    expect(res.json().parcels[0]).toMatchObject({ buyerPaid: 4.2 });
    expect(res.json().moneyLeft).toMatchObject({ wayBack: 4.2 });
  });

  // the receipt came after the money of the goods went and the statement closed: the shop owes the
  // way back now, so the statement is open again until it goes
  it('opens a closed statement again when the corrected sum makes the shop owe the way back', async () => {
    const { returnId } = await wayBackOwed(3, 0);
    expect((await post(`/api/returns/${returnId}/refund`, {})).statusCode).toBe(200);
    const { card, parcel } = await parcelOf(returnId);
    expect(card.closedAt).not.toBeNull();

    const res = await patch(returnId, parcel.id, { buyerPaid: 4.2 });

    expect(res.statusCode).toBe(200);
    expect(res.json().closedAt).toBeNull();
    expect(res.json().moneyLeft).toMatchObject({ wayBack: 4.2 });
    const sent = await post(`/api/returns/${returnId}/refund`, {});
    expect(sent.statusCode).toBe(200);
    expect(sent.json().closedAt).not.toBeNull();
  });

  it('is not corrected once money of the way back went (RETURN_WAY_BACK_PAID)', async () => {
    const { returnId } = await wayBackOwed(3);
    const { parcel } = await parcelOf(returnId);
    expect((await post(`/api/returns/${returnId}/refund`, {})).statusCode).toBe(200);

    const res = await patch(returnId, parcel.id, { buyerPaid: 4.2 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_WAY_BACK_PAID' });
    expect((await parcelOf(returnId)).parcel).toMatchObject({ buyerPaid: 6.5 });
  });

  // the buyer paid the carrier: a cost of the shop would pay the same way back twice
  it('takes no cost of the shop for the parcel the buyer paid the carrier for (RETURN_PARCEL_SUM_INVALID)', async () => {
    const { returnId } = await wayBackOwed(3);
    const { parcel } = await parcelOf(returnId);

    const res = await patch(returnId, parcel.id, { cost: 3 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_PARCEL_SUM_INVALID' });
    expect((await parcelOf(returnId)).card.moneyLeft).toMatchObject({ wayBack: 6.5 });
  });

  it('takes a sum to the cent only, and the cost or the sum, not both', async () => {
    const { returnId } = await wayBackOwed(3);
    const { parcel } = await parcelOf(returnId);

    const cents = await patch(returnId, parcel.id, { buyerPaid: 4.205 });
    const both = await patch(returnId, parcel.id, { buyerPaid: 4.2, cost: 3 });

    expect(cents.statusCode).toBe(400);
    expect(both.statusCode).toBe(400);
  });

  it('warns of a sum above the total of the order', async () => {
    const { returnId } = await wayBackOwed(1);
    const { parcel } = await parcelOf(returnId);
    expect((await parcelOf(returnId)).card.warnings).toEqual([]);

    const res = await patch(returnId, parcel.id, { buyerPaid: 10.01 });

    expect(res.json().warnings).toEqual(['buyer_paid_over_total']);
  });
});

// the way back goes with the transfer of the goods when it can, and by a transfer of its own when it
// is left alone: two statements of an order of three units at
// 10, the first for a unit with the receipt of 6.50, the second for the two others; the transfer of
// the first sends the unit only (the 20 left are the second's), the units of the second never come
describe('a way back left alone', () => {
  async function aloneOwed() {
    const owed = await wayBackOwed(3);
    const items = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId: owed.orderId }, select: { id: true } }),
    );
    const other = await post('/api/returns', {
      orderId: owed.orderId,
      items: [{ orderItemId: items[0]!.id, quantity: 2 }],
      basis: 'other',
      reason: 'defect',
    });
    expect(other.statusCode).toBe(201);
    const first = await post(`/api/returns/${owed.returnId}/refund`, {});
    expect(first.statusCode).toBe(200);
    const closed = await post(
      `/api/returns/${other.json().id}/close`,
      { code: 'goods_not_returned', note: 'The units never came.' },
      root,
    );
    expect(closed.statusCode).toBe(200);
    return owed;
  }

  mockOnly(
    'is among the failures that wait for the shop when the provider refused it',
    async () => {
      const { orderId, returnId } = await aloneOwed();
      queueRefundOutcome({ status: 'failed', reason: 'expired_or_canceled_card' });

      const res = await post(`/api/returns/${returnId}/refund`, {});

      expect(res.statusCode).toBe(200);
      expect(res.json().closedAt).toBeNull();
      const failed = await app.inject({
        method: 'GET',
        url: `/api/payments/refunds?state=failed&orderId=${orderId}`,
        headers: { cookie: accessCookie(admin) },
      });
      expect(failed.json().items).toEqual([
        expect.objectContaining({ purpose: 'return', returnId, amount: 6.5, state: 'failed' }),
      ]);

      // sent again, it is no longer waiting
      expect((await post(`/api/returns/${returnId}/refund`, {})).statusCode).toBe(200);
      const after = await app.inject({
        method: 'GET',
        url: `/api/payments/refunds?state=failed&orderId=${orderId}`,
        headers: { cookie: accessCookie(admin) },
      });
      expect(after.json().items).toEqual([]);
    },
  );
});

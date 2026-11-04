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
  mailsTo,
  statementCodeIn,
  withdrawalLinkIn,
} from '../../helpers/returnJourney.js';
import {
  closeDispute,
  deliver,
  DISPUTED_CARD,
  refundBecomes,
  REFUND_FAIL_CARD,
  refundsOf,
  stripeEvent,
  stripeWait,
} from '../../helpers/stripe.js';

// What becomes of the goods and of the money of a withdrawal from a sent order
// (docs/return-scenarios.md, 9 to 14): goods that come back damaged or worth less, goods that never
// come, a transfer the card refuses, a dispute at the bank, the way back the shop pays. The buyer
// withdraws from the account and sends the parcel by the link of the mail; the admins work from
// the list and the cards. A refusal of Stripe is played by its mock only

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
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
  root = await createUser({ role: 'ROOT' });
  userIds.push(admin.id, root.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// a sent order the buyer withdraws from in full; what each side has of it: the buyer the mails,
// the admin the statement found by the code of the mail
async function withdrawn(units: number, name = 'Desk lamp', card?: string) {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 20, name: `${name} ${buyer.id}` });
  products.push(product);
  const { orderId, paymentId } = await placePaidOrderOf(
    app,
    csrf,
    buyer,
    [{ item: product, quantity: units }],
    card ? { card } : {},
  );
  expect(
    (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' })).statusCode,
  ).toBe(200);
  const mails = watchMail();
  expect((await j.post(buyer, `/api/orders/${orderId}/withdrawal`)).statusCode).toBe(201);

  const notice = mailTo(mails, buyer.email, `Withdrawal from order #${orderId}`);
  const code = statementCodeIn(notice);
  const [found] = (await j.get(admin, `/api/returns?q=${code}`)).json().items;
  return { buyer, product, orderId, paymentId, mails, notice, code, returnId: found.id as number };
}

const cardOf = async (returnId: number) => (await j.get(admin, `/api/returns/${returnId}`)).json();

// the buyer writes the parcel on the page of the link of the notice
async function sendParcel(notice: Parameters<typeof withdrawalLinkIn>[0]) {
  const link = withdrawalLinkIn(notice);
  const res = await j.post(null, '/api/withdrawals/proof', {
    orderId: link.orderId,
    code: link.code,
    returnId: link.returnId,
    carrier: 'DHL',
    trackingNumber: `JD${link.returnId}`,
  });
  expect(res.statusCode).toBe(200);
}

const receive = (returnId: number, results: Array<Record<string, unknown>>) =>
  j.post(admin, `/api/returns/${returnId}/receive`, { results });

describe('the goods that come back', () => {
  it('refuses the money of a unit that came back damaged and tells why, the other unit is back on the shelf', async () => {
    const { buyer, product, mails, returnId, paymentId } = await withdrawn(2);
    const [row] = (await cardOf(returnId)).items;
    const before = await stockOf(product);

    // the unit that is fine goes back first; the rest of the row waits on for its own result
    expect(
      (await receive(returnId, [{ itemId: row.id, quantity: 1, goods: 'to_stock' }])).statusCode,
    ).toBe(200);
    const waiting = (await cardOf(returnId)).items.find(
      (one: { goods: string }) => one.goods === 'expected',
    );
    expect(
      (
        await receive(returnId, [
          { itemId: waiting.id, quantity: 1, goods: 'not_accepted', notAcceptedReason: 'damaged' },
        ])
      ).statusCode,
    ).toBe(200);
    expect((await j.post(admin, `/api/returns/${returnId}/refund`)).statusCode).toBe(200);

    const end = mailTo(mails, buyer.email, 'is closed');
    expect(end.text).toContain('the goods arrived damaged');
    expect(end.text).toContain('€10.00 went back to you.');
    expect((await stockOf(product)).stock).toBe(before.stock + 1);
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([1000]);
  });

  it('keeps part of the price of goods worth less, and the buyer is told the sum and the goods, never the note of root', async () => {
    const { buyer, mails, returnId, paymentId } = await withdrawn(1, 'Kettle');
    const [row] = (await cardOf(returnId)).items;
    expect(
      (await receive(returnId, [{ itemId: row.id, quantity: 1, goods: 'to_stock' }])).statusCode,
    ).toBe(200);

    const paid = await j.post(root, `/api/returns/${returnId}/refund`, {
      reductions: [{ itemId: row.id, amount: 7, note: 'Scratched on the side, used for weeks.' }],
    });

    expect(paid.statusCode).toBe(200);
    const end = mailTo(mails, buyer.email, 'is closed');
    expect(end.text).toContain(
      `We kept €3.00 of the price for the value the goods lost: Kettle ${buyer.id}.`,
    );
    expect(end.text).not.toContain('Scratched');
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([700]);
  });
});

describe('the goods that never come', () => {
  it('closes the rows of goods the buyer never sent, tells the buyer, and the units can be stated again', async () => {
    const { buyer, orderId, mails, returnId } = await withdrawn(1);

    const closed = await j.post(root, `/api/returns/${returnId}/close`, {
      code: 'goods_not_returned',
      note: 'No parcel in 30 days, two letters without an answer.',
    });

    expect(closed.statusCode).toBe(200);
    expect(mailTo(mails, buyer.email, 'is closed').text).toContain(
      'We did not receive the goods back.',
    );
    const page = (await j.get(buyer, `/api/orders/${orderId}`)).json();
    expect(page.withdrawable).toEqual([{ orderItemId: expect.any(Number), quantity: 1 }]);
  });

  it('keeps the money paid ahead of a parcel that never came, and the statement is over', async () => {
    const { notice, returnId, paymentId } = await withdrawn(1);
    await sendParcel(notice);
    expect((await j.post(admin, `/api/returns/${returnId}/proof/confirm`)).statusCode).toBe(200);
    expect((await j.post(admin, `/api/returns/${returnId}/refund`)).statusCode).toBe(200);

    const [row] = (await cardOf(returnId)).items;
    const lost = await receive(returnId, [{ itemId: row.id, quantity: 1, goods: 'not_arrived' }]);

    expect(lost.statusCode).toBe(200);
    expect(lost.json().items).toEqual([
      expect.objectContaining({ goods: 'not_arrived', money: 'refunded' }),
    ]);
    expect(lost.json().closedAt).not.toBeNull();
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([1000]);
  });
});

describe('the money that does not go back the usual way', () => {
  // the card was closed: the refund goes, the bank of the card sends it back (the sandbox: the card
  // of a refund that fails, about 130 s later), Stripe tells it by refund.failed
  it(
    'tells the buyer the bank of the card sent the money back, and root records the money sent another way',
    async () => {
      const { buyer, mails, returnId } = await withdrawn(1, 'Desk lamp', REFUND_FAIL_CARD);
      const [row] = (await cardOf(returnId)).items;
      expect(
        (await receive(returnId, [{ itemId: row.id, quantity: 1, goods: 'to_stock' }])).statusCode,
      ).toBe(200);

      const went = await j.post(admin, `/api/returns/${returnId}/refund`);
      expect(went.json().items[0]).toMatchObject({ money: 'refunded' });
      const refundId = went.json().items[0].refundId as string;
      await refundBecomes(refundId, { status: 'failed', reason: 'expired_or_canceled_card' });
      expect((await deliver(app, await stripeEvent('refund.failed', refundId))).statusCode).toBe(
        200,
      );
      expect(mailTo(mails, buyer.email, 'We could not return the money').text).toContain(
        'sent back to us by the bank of the card',
      );

      // the list of the failed transfers names it; root sends the money by a bank transfer
      const failedList = (
        await j.get(admin, `/api/returns?money=failed&q=${(await cardOf(returnId)).code}`)
      ).json().items;
      expect(failedList).toHaveLength(1);
      const card = await cardOf(returnId);
      const outside = await j.post(root, `/api/returns/${returnId}/refund/outside`, {
        itemIds: [card.items[0].id],
        method: 'bank_transfer',
        note: 'To the account the buyer wrote by mail.',
        at: card.statedAt,
      });
      expect(outside.statusCode).toBe(200);
      expect(outside.json().items[0]).toMatchObject({
        money: 'refunded',
        outside: { method: 'bank_transfer' },
      });
    },
    stripeWait,
  );

  it(
    'records the end of a dispute at the bank: lost, the rows are refunded by chargeback without a mail',
    async () => {
      const { buyer, mails, returnId, paymentId } = await withdrawn(1, 'Desk lamp', DISPUTED_CARD);
      const [row] = (await cardOf(returnId)).items;
      expect(
        (await receive(returnId, [{ itemId: row.id, quantity: 1, goods: 'to_stock' }])).statusCode,
      ).toBe(200);
      expect(
        (await j.post(admin, `/api/returns/${returnId}/refund`)).json().items[0],
      ).toMatchObject({
        refundFailure: { code: 'disputed' },
      });
      const before = mails.length;
      // the bank decides for the buyer; root learns it from Stripe and records it
      await closeDispute(paymentId, 'lost');

      const card = await cardOf(returnId);
      const settled = await j.post(root, `/api/returns/${returnId}/dispute`, {
        outcome: 'lost',
        note: 'The bank gave the buyer the money.',
        at: card.statedAt,
      });

      expect(settled.statusCode).toBe(200);
      expect(settled.json().items[0]).toMatchObject({
        money: 'refunded',
        outside: { method: 'chargeback' },
      });
      expect(mailsTo(mails.slice(before), buyer.email, '')).toEqual([]);
    },
    stripeWait,
  );

  it('pays the buyer back the way back the shop owes, when no parcel of the shop is on the statement', async () => {
    const { buyer, mails, returnId } = await withdrawn(1);
    // the order kept no contract that says the buyer pays: the shop pays the way back
    const card = await cardOf(returnId);
    expect(card).toMatchObject({ deductible: 0, warnings: [] });

    const paidBack = await j.post(root, `/api/returns/${returnId}/reimbursement`, {
      amount: 6.5,
      method: 'bank_transfer',
      note: 'The receipt of the carrier came by mail.',
      at: card.statedAt,
    });

    expect(paidBack.statusCode).toBe(200);
    expect(mailTo(mails, buyer.email, 'We paid back the cost of sending').text).toContain(
      'We paid you back €6.50',
    );
  });
});

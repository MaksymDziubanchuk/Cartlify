import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { alertsOf } from '../../helpers/alerts.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
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
import { giveMoneyRight } from '../../helpers/moneyManager.js';
import { moveClock, placePaidOrderOf } from '../../helpers/payments.js';
import {
  journeyOf,
  mailTo,
  mailsTo,
  statementCodeIn,
  withdrawalLinkIn,
} from '../../helpers/returnJourney.js';
import {
  deliver,
  DISPUTED_CARD,
  queueRefundOutcome,
  realStripe,
  refundBecomes,
  REFUND_FAIL_CARD,
  refundsOf,
  stripeEvent,
  stripeWait,
  withStripeOutOfReach,
} from '../../helpers/stripe.js';
import { settleRefundsInTransit } from '@routes/api/payments/services/settleRefundsInTransit.service.js';

// What becomes of the goods and of the money of a withdrawal from a sent order
// (docs/return-scenarios.md, 9 to 14): goods that come back damaged or worth less, goods that never
// come, a transfer the card refuses, a transfer a dispute at the bank holds, the way back the shop
// pays. The buyer
// withdraws from the account and sends the parcel by the link of the mail; the admins work from
// the list and the cards; what root decides, an admin root gave the right of the money to may
// decide too. A refusal of Stripe is played by its mock only

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
// an admin root gave the right of the money
let cashier: TestUser;
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
  cashier = await createUser({ role: 'ADMIN' });
  await giveMoneyRight(root.id, cashier.id);
  userIds.push(admin.id, root.id, cashier.id);
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

const mockOnly = realStripe ? it.skip : it;

// what waits for the shop is found in the list an alert names, narrowed to the order of the test
// (the alerts are shared by every file that runs at the same time)
const alerts = alertsOf({ app: () => app, csrf: () => csrf });
const DAY = 86_400_000;
const HOUR = 3_600_000;

type MoneyLine = {
  id: number;
  event: string;
  purpose: string;
  part: string;
  amount: number;
  state: string | null;
  orderId: number | null;
  userId: number | null;
  returnId: number | null;
  coversId: number | null;
  actorRole: string | null;
  method: string | null;
  failure: string | null;
};

// the lines of the money journal of the admins under the filters, the oldest first
async function moneyLogOf(query: string): Promise<MoneyLine[]> {
  const res = await j.get(admin, `/api/admin/money-log?${query}&sortOrder=asc&limit=100`);
  expect(res.statusCode).toBe(200);
  return res.json().items;
}

// the rows of a file the admin downloads, without its header
const csvRowsOf = (body: string) =>
  body
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n')
    .slice(1);

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
  j.post(admin, `/api/returns/${returnId}/receive`, { results, parcel: { buyerPaid: 0 } });

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
    expect(end.text).toContain('We sent you €10.00.');
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

    // the admin with the right of the money closes it with the reason
    const closed = await j.post(cashier, `/api/returns/${returnId}/close`, {
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
    expect(
      (await j.post(admin, `/api/returns/${returnId}/proof/confirm`, { buyerPaid: 0 })).statusCode,
    ).toBe(200);
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

// the shop asked the buyer for the money of the parcel that never came; the buyer paid it back by a
// bank transfer and the admin with the right of the money records it on the row of the statement
describe('the money paid ahead the buyer gives back', () => {
  it('is recorded on the row: the statement has nothing back, Stripe is asked for nothing', async () => {
    const { buyer, notice, returnId, paymentId, mails } = await withdrawn(1);
    await sendParcel(notice);
    expect(
      (await j.post(admin, `/api/returns/${returnId}/proof/confirm`, { buyerPaid: 0 })).statusCode,
    ).toBe(200);
    expect((await j.post(admin, `/api/returns/${returnId}/refund`)).statusCode).toBe(200);
    const [row] = (await cardOf(returnId)).items;
    expect(
      (await receive(returnId, [{ itemId: row.id, quantity: 1, goods: 'not_arrived' }])).statusCode,
    ).toBe(200);
    const before = mailsTo(mails, buyer.email, '').length;

    // the admin with the right reads the row in the card of the statement and records the 10 the
    // buyer paid back
    const [{ now }] = await asAdmin(
      (tx) => tx.$queryRaw<{ now: Date }[]>`select (now() at time zone 'UTC') as now`,
    );
    const back = await j.post(cashier, `/api/returns/${returnId}/money-received`, {
      items: [{ itemId: row.id, amount: 10 }],
      method: 'bank_transfer',
      note: 'The buyer paid back the lamp of the parcel that never came.',
      at: now!.toISOString(),
    });

    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ refundedTotal: 0, closedAt: expect.any(String) });
    expect(back.json().items).toEqual([
      expect.objectContaining({ goods: 'not_arrived', money: 'refunded' }),
    ]);
    // the buyer gave the money: no mail
    expect(mailsTo(mails, buyer.email, '')).toHaveLength(before);
    expect((await refundsOf(paymentId)).map((refund) => refund.amount)).toEqual([1000]);
  });
});

describe('a transfer Stripe does not answer', () => {
  mockOnly(
    'stays in transit, the admins see it after three days and the worker sends it',
    async () => {
      const { buyer, orderId, mails, returnId } = await withdrawn(1);
      const [row] = (await cardOf(returnId)).items;
      expect(
        (await receive(returnId, [{ itemId: row.id, quantity: 1, goods: 'to_stock' }])).statusCode,
      ).toBe(200);

      // the admin sends the money; Stripe gives no answer: the row waits, the buyer hears nothing
      const asked = await withStripeOutOfReach(() =>
        j.post(admin, `/api/returns/${returnId}/refund`),
      );
      expect(asked.statusCode).toBe(200);
      expect(asked.json().items).toEqual([expect.objectContaining({ money: 'pending' })]);
      expect(mailsTo(mails, buyer.email, 'is closed')).toEqual([]);

      // three days on, the admins see it among the transfers in transit too long
      const inTransit = async () => {
        const clock = moveClock(3 * DAY + HOUR);
        try {
          return (await alerts.listOf(admin, 'return_refunds_in_transit', { orderId })).items;
        } finally {
          clock.restore();
        }
      };
      expect(await inTransit()).toEqual([
        expect.objectContaining({ purpose: 'return', state: 'in_transit', returnId, amount: 10 }),
      ]);

      // the worker asks Stripe again with the same key: the money is sent, the statement is over
      const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
      const paymentId = (await j.get(admin, `/api/orders/${orderId}`)).json().paymentId as string;
      expect(await settleRefundsInTransit(log, { olderThanMs: 0, paymentId })).toBe(1);
      expect(await cardOf(returnId)).toMatchObject({
        refundedTotal: 10,
        closedAt: expect.any(String),
      });
      expect(mailTo(mails, buyer.email, 'is closed').text).toContain('We sent you €10.00.');
      expect(await inTransit()).toEqual([]);
    },
  );
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
      // the card shows the transfer as the money journal keeps it, with the id Stripe gave
      const goods = went
        .json()
        .money.find((move: { id: number }) => move.id === went.json().items[0].moneyLogId);
      const refundId = goods.refundId as string;
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
      expect(outside.json().items[0]).toMatchObject({ money: 'refunded' });
      expect(outside.json().money.at(-1)).toMatchObject({
        event: 'money.outside',
        method: 'bank_transfer',
        amount: -10,
      });
      // sent, sent back by the bank, sent another way: the buyer got it once
      expect(outside.json().refundedTotal).toBe(10);
    },
    stripeWait,
  );

  // the card was closed and Stripe refuses the transfer at once: the rows wait for root with the
  // reason, the buyer is told; the admin sees it on the card and among the failed refunds; root sends
  // the money by a bank transfer. The buyer's order, the statement and the money journal of the
  // admins then tell the same: the money reached the buyer once. Only the mock refuses a refund at
  // once (the sandbox fails one of a closed card a while after it was sent: the test above)
  mockOnly(
    'shows a transfer Stripe refused to the buyer and the admins, and root sends the money another way once',
    async () => {
      const { buyer, orderId, paymentId, mails, returnId } = await withdrawn(1);
      const [row] = (await cardOf(returnId)).items;
      expect(
        (await receive(returnId, [{ itemId: row.id, quantity: 1, goods: 'to_stock' }])).statusCode,
      ).toBe(200);

      // the admin sends the money; Stripe refuses it, the card can take no money
      queueRefundOutcome({ status: 'failed', reason: 'expired_or_canceled_card' });
      const refused = await j.post(admin, `/api/returns/${returnId}/refund`);
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toMatchObject({ refundedTotal: 0, closedAt: null });
      expect(refused.json().items).toEqual([
        expect.objectContaining({
          money: 'failed',
          refundFailure: expect.objectContaining({ code: 'card_unavailable' }),
        }),
      ]);
      const told = mailTo(mails, buyer.email, 'We could not return the money');
      expect(told.text).toContain('We will contact you about another way to return it.');
      expect(told.text).not.toContain('sent back to us by the bank of the card');

      // Stripe tells of the refund it refused: nothing new, no second mail
      const [stripeRefund] = await refundsOf(paymentId);
      for (const type of ['refund.created', 'refund.failed'] as const) {
        expect((await deliver(app, await stripeEvent(type, stripeRefund!.id))).statusCode).toBe(
          200,
        );
      }
      expect(mailsTo(mails, buyer.email, 'We could not return the money')).toHaveLength(1);

      // the buyer sees the money of the statement failed, nothing went back yet
      const before = (await j.get(buyer, `/api/orders/${orderId}`)).json();
      expect(before.withdrawals).toEqual([
        expect.objectContaining({
          id: returnId,
          refundedTotal: 0,
          refunds: [expect.objectContaining({ way: 'payment', state: 'failed', amount: 10 })],
          items: [expect.objectContaining({ money: 'failed', refundedAt: null })],
        }),
      ]);

      // the admin finds it in the alert of the failed transfers of the statements
      const failedOf = async () =>
        (await alerts.listOf(admin, 'return_refunds_failed', { orderId })).items;
      expect(await failedOf()).toEqual([
        expect.objectContaining({
          purpose: 'return',
          state: 'failed',
          returnId,
          amount: 10,
          failure: 'card_unavailable',
        }),
      ]);

      // root sends the money by a bank transfer, on the day the statement was made
      const card = await cardOf(returnId);
      const outside = await j.post(root, `/api/returns/${returnId}/refund/outside`, {
        itemIds: [card.items[0].id],
        method: 'bank_transfer',
        note: 'To the account the buyer wrote by mail.',
        at: card.statedAt,
      });
      expect(outside.statusCode).toBe(200);
      expect(outside.json()).toMatchObject({ refundedTotal: 10, closedAt: expect.any(String) });
      expect(outside.json().items).toEqual([expect.objectContaining({ money: 'refunded' })]);
      // the money of the last row closes the statement: the mail that closes it tells the sum, the
      // way root sent it and the day
      expect(mailTo(mails, buyer.email, 'is closed').text).toContain(
        'We sent you €10.00 by a bank transfer on ',
      );

      // the buyer sees the money sent another way, once
      const after = (await j.get(buyer, `/api/orders/${orderId}`)).json();
      expect(after.withdrawals).toEqual([
        expect.objectContaining({
          refundedTotal: 10,
          refunds: [
            expect.objectContaining({ way: 'payment', state: 'failed', amount: 10 }),
            expect.objectContaining({
              way: 'outside',
              method: 'bank_transfer',
              state: 'sent',
              amount: 10,
            }),
          ],
          items: [expect.objectContaining({ money: 'refunded', refundedAt: card.statedAt })],
        }),
      ]);
      // nothing waits for the shop any more
      expect(await failedOf()).toEqual([]);

      // the money journal of the admins: paid, sent, refused, sent another way by root
      const lines = await moneyLogOf(`orderId=${orderId}`);
      expect(lines).toEqual([
        expect.objectContaining({
          event: 'money.payment',
          purpose: 'order',
          part: 'goods',
          amount: 10,
          userId: buyer.id,
          returnId: null,
          actorRole: null,
        }),
        expect.objectContaining({
          event: 'money.refund',
          purpose: 'return',
          part: 'goods',
          amount: -10,
          returnId,
          actorRole: 'ADMIN',
        }),
        expect.objectContaining({
          event: 'money.refund_failed',
          purpose: 'return',
          part: 'goods',
          amount: 10,
          returnId,
          failure: 'card_unavailable',
          actorRole: 'ADMIN',
        }),
        expect.objectContaining({
          event: 'money.outside',
          purpose: 'return',
          part: 'goods',
          amount: -10,
          returnId,
          method: 'bank_transfer',
          actorRole: 'ROOT',
        }),
      ]);
      expect(lines[2]!.coversId).toBe(lines[1]!.id);
      // the sum of the lines of the statement is what the buyer got
      expect(
        lines
          .filter((line) => line.returnId === returnId)
          .reduce((sum, line) => sum - line.amount, 0),
      ).toBe(10);

      // the same lines by the buyer, and in the file the admin downloads
      expect((await moneyLogOf(`userId=${buyer.id}`)).map((line) => line.id)).toEqual(
        lines.map((line) => line.id),
      );
      const csv = await j.get(
        admin,
        `/api/admin/money-log?orderId=${orderId}&sortOrder=asc&format=csv&columns=event,part,amount,method`,
      );
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csvRowsOf(csv.body)).toEqual([
        'money.payment,goods,10.00,',
        'money.refund,goods,-10.00,',
        'money.refund_failed,goods,10.00,',
        'money.outside,goods,-10.00,bank_transfer',
      ]);
    },
  );

  // the buyer disputed the payment at the bank: Stripe refuses the refund, the bank settles it. The
  // rows wait with the dispute as the reason and the buyer is not told the shop cannot send it; what
  // the end of the dispute does to the statement is the work of the webhook of the disputes
  it('holds a transfer the bank disputes, without a word to the buyer', async () => {
    const { buyer, mails, returnId } = await withdrawn(1, 'Desk lamp', DISPUTED_CARD);
    const [row] = (await cardOf(returnId)).items;
    expect(
      (await receive(returnId, [{ itemId: row.id, quantity: 1, goods: 'to_stock' }])).statusCode,
    ).toBe(200);
    const before = mails.length;

    const refused = await j.post(admin, `/api/returns/${returnId}/refund`);

    expect(refused.statusCode).toBe(200);
    expect(refused.json().items[0]).toMatchObject({
      money: 'failed',
      refundFailure: { code: 'disputed' },
    });
    expect(refused.json().refundedTotal).toBe(0);
    expect(mailsTo(mails.slice(before), buyer.email, '')).toEqual([]);
    // the admin finds it among the statements whose transfer failed
    const failedList = (
      await j.get(admin, `/api/returns?money=failed&q=${(await cardOf(returnId)).code}`)
    ).json().items;
    expect(failedList).toHaveLength(1);
  });

  it('pays the buyer back the way back the shop owes, outside the app when the payment holds only the goods', async () => {
    const { buyer, mails, returnId } = await withdrawn(1);
    // the order kept no contract that says the buyer pays: the shop pays the way back
    const card = await cardOf(returnId);
    expect(card).toMatchObject({ deductible: 0, warnings: [] });

    // the goods come in with the receipt of the carrier: the buyer paid 6.50
    const taken = await j.post(admin, `/api/returns/${returnId}/receive`, {
      results: [{ itemId: card.items[0].id, quantity: card.items[0].quantity, goods: 'to_stock' }],
      parcel: { buyerPaid: 6.5 },
    });
    expect(taken.statusCode).toBe(200);
    // the payment holds the goods of the whole order and no more: they go alone
    expect((await j.post(admin, `/api/returns/${returnId}/refund`)).statusCode).toBe(200);
    const paidBack = await j.post(root, `/api/returns/${returnId}/refund/outside`, {
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

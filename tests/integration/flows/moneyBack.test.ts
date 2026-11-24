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
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { giveMoneyRight } from '../../helpers/moneyManager.js';
import { placePaidOrder } from '../../helpers/payments.js';
import { journeyOf, mailTo, mailsTo, statementCodeIn } from '../../helpers/returnJourney.js';
import {
  closeOpenSessions,
  deliver,
  realStripe,
  refundAtStripe,
  refundsOf,
  stripeEvent,
} from '../../helpers/stripe.js';

// The money that comes back to the shop outside the app, each step with what its actor sees:
// a carrier loses a send and pays the shop for it; root records it on the
// send, money of the shop that changes no cost of the send. And money already with the buyer for
// units of the order: an admin gave money back by hand in the dashboard of Stripe and an admin with
// the right of the money (as root may) said it was for a lamp, all its price (the shop bought it
// back) or a part of it (a scratch); the lamps come back in a statement and the admin marks at the
// reception which of them that money paid. The rules and the refusals are
// api/orders/carrierMoney.test.ts and db/returnMoney.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
// an admin root gave the right of the money: it says what money given back by hand was for, as root does
let cashier: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
const j = journeyOf(
  () => app,
  () => csrf,
);

const mockOnly = realStripe ? it.skip : it;
const alerts = alertsOf({ app: () => app, csrf: () => csrf });

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
    await closeOpenSessions();
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// a buyer of the test and an order of two lamps at 10 Stripe took the money for
async function paidOrder() {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10, name: `Desk lamp ${buyer.id}` });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 2 });
  return { ...placed, buyer, product };
}

// the time of the database: the day money really came
const dbNow = async () =>
  (
    await asAdmin((tx) => tx.$queryRaw<{ now: Date }[]>`select (now() at time zone 'UTC') as now`)
  )[0]!.now.toISOString();

describe('money a carrier pays for a send it lost', () => {
  it('is recorded by root on the send: money of the shop, the cost of the send stays', async () => {
    const { orderId } = await paidOrder();
    const shipped = await j.patch(admin, `/api/orders/${orderId}/status`, {
      status: 'shipped',
      shipments: [{ carrier: 'DHL', trackingNumber: '1Z999AA10123456784', cost: 6 }],
    });
    expect(shipped.statusCode).toBe(200);

    // the parcel is lost: root reads the send in the card of the order and records what DHL paid
    const [send] = (await j.get(root, `/api/orders/${orderId}`)).json().shipments as {
      id: number;
      cost: number;
    }[];
    expect(send).toMatchObject({ cost: 6 });
    const paid = await j.post(root, `/api/orders/${orderId}/shipments/${send!.id}/carrier-money`, {
      amount: 20,
      method: 'bank_transfer',
      note: 'DHL paid the value of the lost parcel.',
      at: await dbNow(),
    });

    expect(paid.statusCode).toBe(200);
    expect(paid.json().shipments).toEqual([expect.objectContaining({ id: send!.id, cost: 6 })]);
    expect(paid.json().money).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'money.received', purpose: 'shipping', amount: 20 }),
      ]),
    );
  });
});

describe('money already with the buyer for a lamp of the order', () => {
  type Row = {
    id: number;
    quantity: number;
    money: string;
    paidUnits: number;
    paidUnitsLeft: number;
  };
  type Card = {
    items: Row[];
    refundedTotal: number;
    closedAt: string | null;
    money: { part: string; amount: number; coversId: number | null }[];
  };
  const cardOf = async (returnId: number): Promise<Card> => {
    const res = await j.get(admin, `/api/returns/${returnId}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  // what money already with the buyer paid of the statement: the parts covered of its card
  const coveredOf = (card: Card) =>
    card.money.filter((one) => one.part === 'covered').map((one) => [one.amount, one.coversId]);
  // the refunds of the payment at Stripe, by their sums
  const stripeSums = async (paymentId: string) =>
    (await refundsOf(paymentId)).map((one) => one.amount).sort((a, b) => a - b);

  // the order of two lamps at 10 went; an admin gave money back by hand in the dashboard of Stripe,
  // and the admin with the right of the money, finding it among the refunds to say what they were
  // for, says it was for one lamp
  async function paidByHand(cents: number, note: string) {
    const { buyer, orderId, paymentId } = await paidOrder();
    expect(
      (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' })).statusCode,
    ).toBe(200);
    const byHand = await refundAtStripe(paymentId, { amount: cents });
    expect((await deliver(app, await stripeEvent('refund.created', byHand.id))).statusCode).toBe(
      200,
    );
    const [refund] = (await alerts.listOf(cashier, 'hand_refunds_to_explain', { orderId }))
      .items as { id: number }[];
    const [item] = (await j.get(cashier, `/api/orders/${orderId}`)).json().items as {
      id: number;
    }[];
    const decided = await j.post(cashier, `/api/payments/money-lines/${refund!.id}/decision`, {
      items: [{ orderItemId: item!.id, quantity: 1, amount: cents / 100 }],
      note,
    });
    expect(decided.statusCode).toBe(200);
    return { buyer, orderId, paymentId, refundId: refund!.id };
  }

  // the buyer withdraws from lamps of the order on its page (all of them without a number); the admin
  // finds the statement by the code of the mail and reads its row: how many lamps money already with
  // the buyer is still to be marked for
  async function withdrawn(buyer: TestUser, orderId: number, units?: number) {
    const mails = watchMail();
    const [free] = (await j.get(buyer, `/api/orders/${orderId}`)).json().withdrawable;
    const made = await j.post(
      buyer,
      `/api/orders/${orderId}/withdrawal`,
      units === undefined ? {} : { items: [{ orderItemId: free.orderItemId, quantity: units }] },
    );
    expect(made.statusCode).toBe(201);
    const code = statementCodeIn(mailTo(mails, buyer.email, `Withdrawal from order #${orderId}`));
    const [found] = (await j.get(admin, `/api/returns?q=${code}`)).json().items;
    const returnId = found.id as number;
    const [row] = (await cardOf(returnId)).items;
    expect(row).toMatchObject({ paidUnits: 0, paidUnitsLeft: 1 });
    return { returnId, row: row!, mails };
  }

  mockOnly(
    'is the price of a lamp the shop bought back: of the two lamps that come back, that one is written off and paid already, the other refused',
    async () => {
      const { buyer, orderId, paymentId, refundId } = await paidByHand(
        1000,
        'The shop bought a lamp back: it came broken.',
      );
      const { returnId, row, mails } = await withdrawn(buyer, orderId);

      // the broken lamp is the one bought back: written off, and nothing is owed for it; the other
      // came used and is not accepted
      const taken = await j.post(admin, `/api/returns/${returnId}/receive`, {
        parcel: { buyerPaid: 0 },
        results: [
          { itemId: row.id, quantity: 1, goods: 'written_off', paidUnits: 1 },
          { itemId: row.id, quantity: 1, goods: 'not_accepted', notAcceptedReason: 'used' },
        ],
      });
      expect(taken.statusCode).toBe(200);

      // the statement is over: the lamp bought back is paid by the money the buyer has
      const card = await cardOf(returnId);
      expect(card.items.map((one) => [one.quantity, one.money, one.paidUnits]).sort()).toEqual([
        [1, 'refunded', 1],
        [1, 'refused', 0],
      ]);
      expect(card).toMatchObject({ refundedTotal: 10, closedAt: expect.any(String) });
      expect(coveredOf(card)).toEqual([[10, refundId]]);
      expect(await stripeSums(paymentId)).toEqual([1000]);
      expect(mailsTo(mails, buyer.email, `Return of order #${orderId} is closed`)).toHaveLength(1);
    },
  );

  mockOnly(
    'is a part of the price of the lamp that came scratched: the other lamp, sent back whole, has all its price back',
    async () => {
      const { buyer, orderId, paymentId } = await paidByHand(400, 'A lamp came scratched: 4 off.');
      const { returnId, row, mails } = await withdrawn(buyer, orderId, 1);

      // the lamp that came is the whole one: the money of the scratch is not for it
      const taken = await j.post(admin, `/api/returns/${returnId}/receive`, {
        parcel: { buyerPaid: 0 },
        results: [{ itemId: row.id, quantity: 1, goods: 'to_stock', paidUnits: 0 }],
      });
      expect(taken.statusCode).toBe(200);
      const sent = await j.post(admin, `/api/returns/${returnId}/refund`);
      expect(sent.statusCode).toBe(200);

      expect(await cardOf(returnId)).toMatchObject({
        refundedTotal: 10,
        closedAt: expect.any(String),
      });
      expect(mailTo(mails, buyer.email, `Return of order #${orderId} is closed`).text).toContain(
        'We sent you €10.00.',
      );
      expect(await stripeSums(paymentId)).toEqual([400, 1000]);
    },
  );

  mockOnly(
    'is a part of the price of the lamp that came scratched: that lamp, sent back used, is written off and its money lowered to what the buyer has',
    async () => {
      const { buyer, orderId, paymentId, refundId } = await paidByHand(
        400,
        'A lamp came scratched: 4 off.',
      );
      const { returnId, row, mails } = await withdrawn(buyer, orderId, 1);

      const taken = await j.post(admin, `/api/returns/${returnId}/receive`, {
        parcel: { buyerPaid: 0 },
        results: [{ itemId: row.id, quantity: 1, goods: 'written_off', paidUnits: 1 }],
      });
      expect(taken.statusCode).toBe(200);
      expect((await cardOf(returnId)).items).toEqual([
        expect.objectContaining({ money: 'not_refunded', paidUnits: 1, paid: 4 }),
      ]);

      // the buyer used the lamp: the admin with the right of the money lowers it down to the 4 the
      // buyer has already, nothing is asked of Stripe
      const lowered = await j.post(cashier, `/api/returns/${returnId}/refund`, {
        reductions: [{ itemId: row.id, amount: 4, note: 'Used for weeks after the scratch.' }],
      });
      expect(lowered.statusCode).toBe(200);
      const card = await cardOf(returnId);
      expect(card).toMatchObject({ refundedTotal: 4, closedAt: expect.any(String) });
      expect(coveredOf(card)).toEqual([[4, refundId]]);
      expect(await stripeSums(paymentId)).toEqual([400]);
      expect(mailsTo(mails, buyer.email, `Return of order #${orderId} is closed`)).toHaveLength(1);
    },
  );

  mockOnly(
    'is a loss of the shop when the admin sent the price of the lamp bought back ahead of it, on the proof of its parcel',
    async () => {
      const { buyer, orderId, paymentId, refundId } = await paidByHand(
        1000,
        'The shop bought a lamp back: it came broken.',
      );
      const { returnId, row } = await withdrawn(buyer, orderId, 1);

      // the parcel is confirmed, the admin sends the money ahead of the goods
      expect(
        (await j.post(admin, `/api/returns/${returnId}/proof/confirm`, { buyerPaid: 0 }))
          .statusCode,
      ).toBe(200);
      expect((await j.post(admin, `/api/returns/${returnId}/refund`)).statusCode).toBe(200);
      expect(await stripeSums(paymentId)).toEqual([1000, 1000]);

      // the lamp that comes is the one bought back: the buyer had its price twice
      const taken = await j.post(admin, `/api/returns/${returnId}/receive`, {
        results: [{ itemId: row.id, quantity: 1, goods: 'written_off', paidUnits: 1 }],
      });
      expect(taken.statusCode).toBe(200);
      expect(await cardOf(returnId)).toMatchObject({
        refundedTotal: 10,
        closedAt: expect.any(String),
      });

      // root reads in the money journal that the money given back by hand for it is a loss of the shop
      const [hand] = (
        await j.get(root, `/api/admin/money-log?orderId=${orderId}&purpose=hand`)
      ).json().items as { id: number; meta: Record<string, unknown>[] }[];
      expect(hand).toMatchObject({ id: refundId });
      expect(hand!.meta).toEqual(
        expect.arrayContaining([expect.objectContaining({ lost: 10, lostReturnItemId: row.id })]),
      );
    },
  );
});

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
  stripeEvent,
} from '../../helpers/stripe.js';

// The money that comes back to the shop outside the app, each step with what its actor sees:
// a carrier loses a send and pays the shop for it; root records it on the
// send, money of the shop that changes no cost of the send. And money already with the buyer for
// goods the shop did not accept: the buyer sent the lamps back used and the shop did not accept
// them, then an admin gave half of the payment back by hand and root said it was for a lamp; an
// admin with the right of the money (as root may) finds the statement in the alert of the money
// given too much and keeps the lamps that are still in the shop, records what the buyer gave back,
// or gives it up. The rules and the refusals are api/orders/carrierMoney.test.ts,
// api/returns/overpaid.test.ts and api/admin/alertsMoney.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
// an admin root gave the right of the money: it works what is overpaid as root does
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
      shipment: { carrier: 'DHL', trackingNumber: '1Z999AA10123456784', cost: 6 },
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

describe('money already with the buyer for goods the shop did not accept', () => {
  // the buyer sent the lamps back used and the shop did not accept them; then an admin gave half of
  // the payment back by hand in the dashboard of Stripe and root said it was for one lamp: the
  // buyer has the lamps and the money of one. Root finds the statement in the alert of the money
  // given too much
  async function overpaidLamps() {
    const { buyer, orderId, paymentId } = await paidOrder();
    expect(
      (await j.patch(admin, `/api/orders/${orderId}/status`, { status: 'shipped' })).statusCode,
    ).toBe(200);
    const mails = watchMail();
    expect((await j.post(buyer, `/api/orders/${orderId}/withdrawal`)).statusCode).toBe(201);
    const code = statementCodeIn(mailTo(mails, buyer.email, `Withdrawal from order #${orderId}`));
    const [found] = (await j.get(admin, `/api/returns?q=${code}`)).json().items;
    const returnId = found.id as number;
    const [row] = (await j.get(admin, `/api/returns/${returnId}`)).json().items;
    expect(
      (
        await j.post(admin, `/api/returns/${returnId}/receive`, {
          parcel: { buyerPaid: 0 },
          results: [
            { itemId: row.id, quantity: 2, goods: 'not_accepted', notAcceptedReason: 'used' },
          ],
        })
      ).statusCode,
    ).toBe(200);

    const byHand = await refundAtStripe(paymentId, { amount: 1000 });
    expect((await deliver(app, await stripeEvent('refund.created', byHand.id))).statusCode).toBe(
      200,
    );
    const [refund] = (await alerts.listOf(root, 'hand_refunds_to_explain', { orderId })).items as {
      id: number;
    }[];
    const [item] = (await j.get(root, `/api/orders/${orderId}`)).json().items as { id: number }[];
    expect(
      (
        await j.post(root, `/api/payments/money-lines/${refund!.id}/decision`, {
          items: [{ orderItemId: item!.id, quantity: 1, amount: 10 }],
          note: 'The refund was for a lamp.',
        })
      ).statusCode,
    ).toBe(200);

    const overpaid = async () =>
      (await alerts.listOf(cashier, 'returns_money_overpaid', { userId: buyer.id })).items.map(
        (one) => one.id,
      );
    expect(await overpaid()).toEqual([returnId]);
    expect((await j.get(root, `/api/returns/${returnId}`)).json()).toMatchObject({
      moneyOverpaid: 10,
    });
    return { buyer, orderId, returnId, rowId: row.id as number, overpaid, mails };
  }

  mockOnly(
    'is the money of lamps the shop keeps: they are still in the shop and written off',
    async () => {
      const { buyer, orderId, returnId, rowId, overpaid, mails } = await overpaidLamps();

      // the lamps did not go back: root keeps them, written off; the money already with the buyer
      // pays one of the two, the statement waits for the other, which the admin sends as always
      const kept = await j.post(cashier, `/api/returns/${returnId}/keep`, {
        items: [{ itemId: rowId, goods: 'written_off' }],
        note: 'The bank paid the buyer for a lamp: the shop keeps them.',
      });
      expect(kept.statusCode).toBe(200);
      expect(kept.json()).toMatchObject({ moneyOverpaid: 0, refundedTotal: 0, closedAt: null });
      expect(await overpaid()).toEqual([]);
      expect((await j.post(admin, `/api/returns/${returnId}/refund`)).statusCode).toBe(200);

      // the buyer is told the statement is over again, now with all of its money (the first mail of
      // the end told the refusal)
      const closed = mailsTo(mails, buyer.email, `Return of order #${orderId} is closed`);
      expect(closed).toHaveLength(2);
      expect(closed[1]!.text).toContain('€20.00');
    },
  );

  mockOnly('is given back by the buyer once the lamps went back: root records it', async () => {
    const { returnId, rowId, overpaid } = await overpaidLamps();
    const sent = await j.post(admin, `/api/returns/${returnId}/shipments`, {
      direction: 'to_buyer',
      items: [{ itemId: rowId, quantity: 2 }],
      carrier: 'DHL',
      trackingNumber: 'JD0146000777',
      cost: 6,
      shippedAt: await dbNow(),
    });
    expect(sent.statusCode).toBe(201);

    const back = await j.post(cashier, `/api/returns/${returnId}/overpaid/received`, {
      amount: 10,
      method: 'bank_transfer',
      note: 'The buyer paid the lamp back.',
      at: await dbNow(),
    });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ moneyOverpaid: 0 });
    expect(await overpaid()).toEqual([]);
  });

  mockOnly(
    'is a loss of the shop when the buyer will not give it back: root gives it up',
    async () => {
      const { orderId, returnId, overpaid } = await overpaidLamps();

      const lost = await j.post(cashier, `/api/returns/${returnId}/overpaid/lost`, {
        note: 'The buyer does not answer.',
      });
      expect(lost.statusCode).toBe(200);
      expect(await overpaid()).toEqual([]);

      // the journal of the money says what the share became
      const lines = (
        await j.get(root, `/api/admin/money-log?orderId=${orderId}&events=money.share_moved`)
      ).json().items;
      expect(lines).toEqual([
        expect.objectContaining({ purpose: 'hand', amount: 0, moneyUse: 'compensation' }),
      ]);
    },
  );
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import appStripe from '@config/stripe.js';
import { settleRefundsInTransit } from '@routes/api/payments/services/settleRefundsInTransit.service.js';

import { accessCookie } from '../../helpers/actors.js';
import { alertsOf } from '../../helpers/alerts.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
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
import { moveClock, placePaidOrder } from '../../helpers/payments.js';
import {
  closeOpenSessions,
  deliver,
  disputeEvent,
  endDispute,
  openDispute,
  outOfReachDuring,
  PENDING_REFUND_CARD,
  realStripe,
  refundAtStripe,
  settleRefund,
  stripeEvent,
  withStripeOutOfReach,
} from '../../helpers/stripe.js';

// The money on its way to the buyer that the shop has to watch, each step with what its actor sees
// (every alert from its coming to its end): a compensation Stripe
// did not answer, a refund made by hand that Stripe keeps pending, and the rest of a payment the app
// sends after a dispute lost on part of it, on its way or refused by the card. An admin with the right
// of the money finds each in its alert days on, and sees it go once the money went. The rules and
// the counts of the kinds are api/admin/alertsMoney.test.ts, alertsHandRefunds.test.ts and
// alertsDisputes.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let cashier: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
const mockOnly = realStripe ? it.skip : it;
const alerts = alertsOf({ app: () => app, csrf: () => csrf });

const DAY = 86_400_000;
const HOUR = 3_600_000;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT' });
  // an admin root allowed to handle the money: the money kinds are theirs as root's
  cashier = await createUser({ role: 'ADMIN' });
  userIds.push(root.id, cashier.id);
  await giveMoneyRight(root.id, cashier.id);
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

const post = (actor: TestUser, url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: withCsrf(csrf, accessCookie(actor)), payload });

// a buyer of the test with an order of two lamps at 10 Stripe took the money for
async function paidOrder(opts: { stage?: 'paid' | 'shipped'; card?: string } = {}) {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10, name: `Desk lamp ${buyer.id}` });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 2, ...opts });
  return { ...placed, buyer };
}

// the cases of a kind for the buyer as the admin sees them a few days on (the alerts count the days
// by the clock of the app)
async function seenDaysOn(kind: string, buyer: TestUser, days = 3) {
  const clock = moveClock(days * DAY + HOUR);
  try {
    return (await alerts.listOf(cashier, kind, { userId: buyer.id })).items as {
      id: number;
      purpose: string;
      state: string;
      amount: number;
      at: string;
    }[];
  } finally {
    clock.restore();
  }
}

const workerLog = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

// the bank of the buyer opens a dispute of part of the payment, and ends it for the buyer
async function lostOnPart(paymentId: string) {
  const disputeId = openDispute(paymentId, { amount: 1500 });
  for (const type of ['charge.dispute.created', 'charge.dispute.funds_withdrawn']) {
    expect((await deliver(app, await disputeEvent(type, disputeId))).statusCode).toBe(200);
  }
  endDispute(disputeId, 'lost');
  expect(
    (await deliver(app, await disputeEvent('charge.dispute.closed', disputeId))).statusCode,
  ).toBe(200);
}

describe('money on its way to the buyer that the shop watches', () => {
  mockOnly(
    'a compensation Stripe did not answer waits in its alert until the worker sends it, and the buyer is told once',
    async () => {
      const { buyer, orderId, paymentId } = await paidOrder({ stage: 'shipped' });
      const mails = watchMail();

      const given = await withStripeOutOfReach(() =>
        post(cashier, '/api/payments/compensations', {
          orderId,
          amount: 5,
          note: 'The parcel came three days late.',
        }),
      );
      expect(given.json()).toMatchObject({ state: 'in_transit' });
      expect(mails.filter((mail) => mail.to.includes(buyer.email))).toEqual([]);

      expect(await seenDaysOn('compensation_refunds_in_transit', buyer)).toEqual([
        expect.objectContaining({ purpose: 'compensation', state: 'in_transit', amount: 5 }),
      ]);

      const log = workerLog();
      expect(await settleRefundsInTransit(log, { olderThanMs: 0, paymentId })).toBe(1);
      expect(log.error).not.toHaveBeenCalled();
      expect(
        mails.filter(
          (mail) =>
            mail.to.includes(buyer.email) &&
            mail.subject.includes('We sent you a compensation for order #'),
        ),
      ).toHaveLength(1);
      expect(await seenDaysOn('compensation_refunds_in_transit', buyer)).toEqual([]);
    },
  );

  mockOnly(
    'a refund made by hand that Stripe keeps pending waits in its alert until Stripe tells it sent',
    async () => {
      const { buyer, paymentId } = await paidOrder({ stage: 'shipped', card: PENDING_REFUND_CARD });
      const byHand = await refundAtStripe(paymentId, { amount: 500 });
      expect((await deliver(app, await stripeEvent('refund.created', byHand.id))).statusCode).toBe(
        200,
      );

      expect(await seenDaysOn('hand_refunds_in_transit', buyer)).toEqual([
        expect.objectContaining({ purpose: 'hand', state: 'in_transit', amount: 5 }),
      ]);

      settleRefund(byHand.id, { status: 'succeeded' });
      expect((await deliver(app, await stripeEvent('refund.updated', byHand.id))).statusCode).toBe(
        200,
      );
      expect(await seenDaysOn('hand_refunds_in_transit', buyer)).toEqual([]);
    },
  );

  mockOnly(
    'the rest after a dispute lost on part of an order not sent waits in its alert until the worker sends it',
    async () => {
      const { buyer, paymentId } = await paidOrder();
      outOfReachDuring(appStripe.refunds, 'create');
      try {
        await lostOnPart(paymentId);
      } finally {
        jest.restoreAllMocks();
      }

      const [rest, ...others] = await seenDaysOn('dispute_refunds_in_transit', buyer);
      expect(others).toEqual([]);
      expect(rest).toMatchObject({ purpose: 'dispute_remainder', state: 'in_transit', amount: 5 });

      expect(await settleRefundsInTransit(workerLog(), { olderThanMs: 0, paymentId })).toBe(1);
      expect(await seenDaysOn('dispute_refunds_in_transit', buyer)).toEqual([]);
    },
  );

  mockOnly(
    'the rest after a dispute lost that Stripe refused is sent another way by the admin, from its alert',
    async () => {
      const { buyer, paymentId } = await paidOrder();
      await lostOnPart(paymentId);

      const failed = async () =>
        (await alerts.listOf(cashier, 'dispute_refunds_failed', { userId: buyer.id })).items as {
          id: number;
          returnId: number;
          at: string;
          amount: number;
        }[];
      const [rest, ...others] = await failed();
      expect(others).toEqual([]);
      expect(rest).toMatchObject({ amount: 5, returnId: expect.any(Number) });

      // the rest is the money of the statement of the system: it goes outside the app by the
      // statement
      const sent = await post(cashier, `/api/returns/${rest!.returnId}/refund/outside`, {
        method: 'bank_transfer',
        note: 'To the account the buyer wrote by mail.',
        at: rest!.at,
      });
      expect(sent.statusCode).toBe(200);
      expect(await failed()).toEqual([]);
    },
  );
});

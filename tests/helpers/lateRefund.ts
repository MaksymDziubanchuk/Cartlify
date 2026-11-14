import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { asAdmin } from './db.js';
import type { Csrf } from './csrf.js';
import {
  createProduct,
  createUser,
  writeOffStock,
  type TestProduct,
  type TestUser,
} from './factories.js';
import { loseReservation, placeOrder } from './orders.js';
import { openPaymentPage, payPage } from './payments.js';
import { craftEvent, deliver, refundBecomes, refundsOf, stripeEvent } from './stripe.js';

// A payment the order could not take, refunded by the webhook, and the events of the refund. The
// payment is 51.00 (2 units of 25.50): the buyer pays the page after the reservation is over and
// the stock is gone, the test delivers the event Stripe recorded for the page. What became of the
// money is the lines of the money journal of the payment (db/05, money_log): the late payment came
// (+), the refund went out in transit (-), it was told sent, or it failed (+ again)

export const LATE_REFUND_AMOUNT = '51.00';

// the lines of the money journal of a payment, oldest first, with what a test looks at
export const moneyOfPayment = async (paymentId: string) =>
  (
    await asAdmin((tx) =>
      tx.moneyLog.findMany({
        where: { paymentId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          event: true,
          purpose: true,
          part: true,
          amount: true,
          currency: true,
          orderId: true,
          userId: true,
          actorId: true,
          state: true,
          refundId: true,
          transferKey: true,
          byDashboard: true,
          coversId: true,
          failure: true,
          failureText: true,
          method: true,
          note: true,
          happenedAt: true,
          meta: true,
        },
      }),
    )
  ).map((line) => ({ ...line, amount: line.amount.toFixed(2) }));

// the events of the lines of a payment, with the state of a refund, in the order they were written:
// what happened to its money at a glance
export const moneyStepsOf = async (paymentId: string) =>
  (await moneyOfPayment(paymentId)).map((line) =>
    line.state ? `${line.event}:${line.state}` : line.event,
  );

// the lock the database takes for a payment while it changes its refunds (lock_money_payment,
// db/05): the changes of one payment go one after another
export const lockMoneyPayment = async (tx: Prisma.TransactionClient, paymentId: string) => {
  await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${`cartlify.money_payment:${paymentId}`}))`;
};

export type LatePayment = {
  user: TestUser;
  product: TestProduct;
  orderId: number;
  sessionId: string;
  paymentId: string;
  // the event Stripe recorded for the paid page
  event: Awaited<ReturnType<typeof payPage>>['event'];
};

type LatePaymentDeps = {
  app: FastifyInstance;
  csrf: Csrf;
  // the users and the products a file made, for it to clean up
  users: number[];
  products: TestProduct[];
};

// a buyer whose payment came after the stock was gone: nothing is delivered yet
export async function latePayment(
  deps: LatePaymentDeps,
  buyer: Parameters<typeof createUser>[0] = {},
): Promise<LatePayment> {
  const user = await createUser(buyer);
  deps.users.push(user.id);
  const product = await createProduct({ price: 25.5, stock: 5 });
  deps.products.push(product);

  const orderId = await placeOrder(deps.app, deps.csrf, user, product, 'waiting', 2);
  const sessionId = await openPaymentPage(deps.app, deps.csrf, user, orderId);
  await loseReservation(orderId);
  await writeOffStock(product.id, 4);
  const paid = await payPage(sessionId);

  return { user, product, orderId, sessionId, ...paid };
}

// the event of Stripe for a refund of the app, as the webhook gets it. The refund is the one
// Stripe made for the payment (its id), or a made-up one
export function refundEvent(
  type: 'refund.created' | 'refund.updated' | 'refund.failed',
  refund: {
    id: string;
    paymentId: string;
    status: 'succeeded' | 'pending' | 'failed' | 'canceled';
    reason?: string;
    // the key of the app rides in the metadata; none for a refund made by hand
    metadata?: Record<string, string>;
    // in cents; 5100 unless given
    amount?: number;
  },
) {
  return craftEvent(type, {
    object: 'refund',
    id: refund.id,
    amount: refund.amount ?? 5100,
    currency: 'eur',
    created: Math.floor(Date.now() / 1000),
    status: refund.status,
    payment_intent: refund.paymentId,
    ...(refund.reason ? { failure_reason: refund.reason } : {}),
    metadata: refund.metadata ?? { transfer: `refund:${refund.paymentId}` },
  });
}

// the refund Stripe made for the payment (the only one the app made)
export async function refundOf(paymentId: string) {
  const refunds = await refundsOf(paymentId);
  if (refunds.length !== 1) throw new Error(`the payment has ${refunds.length} refunds`);
  return refunds[0]!;
}

// delivers the event and checks the answer is a plain acknowledgement
export async function deliverOk(app: FastifyInstance, event: unknown) {
  const res = await deliver(app, event);
  if (res.statusCode !== 200) throw new Error(`the webhook answered ${res.statusCode}`);
  return res;
}

// a late payment whose refund was made and then failed (Stripe says so): the money did not reach the
// buyer, the refund waits for root. Returns the payment with the id of the refund
export async function failedLateRefund(
  deps: LatePaymentDeps,
  buyer: Parameters<typeof createUser>[0] = {},
  reason = 'expired_or_canceled_card',
): Promise<LatePayment & { refundId: string }> {
  const late = await latePayment(deps, buyer);
  await deliverOk(deps.app, late.event);
  const refund = await refundOf(late.paymentId);
  await deliverOk(
    deps.app,
    refundEvent('refund.failed', {
      id: refund.id,
      paymentId: late.paymentId,
      status: 'failed',
      reason,
    }),
  );

  return { ...late, refundId: refund.id };
}

// the same, the refund failed at Stripe too, as the refund of a card that is gone fails there (the
// mock ends it so; the sandbox fails one of REFUND_FAIL_CARD on its own): the payment can be refunded
// again, as the app does after a dispute the shop won (mock only)
export async function lateRefundFailedAtStripe(
  deps: LatePaymentDeps,
): Promise<LatePayment & { refundId: string }> {
  const late = await latePayment(deps);
  await deliverOk(deps.app, late.event);
  const refund = await refundOf(late.paymentId);
  await refundBecomes(refund.id, { status: 'failed', reason: 'expired_or_canceled_card' });
  await deliverOk(deps.app, await stripeEvent('refund.failed', refund.id));

  return { ...late, refundId: refund.id };
}

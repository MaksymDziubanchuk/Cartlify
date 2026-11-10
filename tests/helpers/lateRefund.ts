import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { lateRefundLockKey } from '@routes/api/payments/services/helpers/lateRefundRows.helper.js';

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
import { craftEvent, deliver, refundsOf } from './stripe.js';

// A payment the order could not take, refunded by the webhook, and the events of the refund. The
// payment is 51.00 (2 units of 25.50): the buyer pays the page after the reservation is over and
// the stock is gone, the test delivers the event Stripe recorded for the page

export const LATE_REFUND_AMOUNT = '51.00';

export const LATE_REFUND_EVENTS = [
  'order.refund_late',
  'order.refund_late_sent',
  'order.refund_late_failed',
  'order.refund_late_outside',
] as const;

// the lines of the admin log about the late refunds of an order, oldest first
export const lateLinesOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: {
        entityType: 'order',
        entityId: orderId,
        action: 'OTHER',
        event: { in: [...LATE_REFUND_EVENTS] },
      },
      orderBy: { id: 'asc' },
    }),
  );

// the events of those lines, in the order they were written
export const lateEventsOf = async (orderId: number) =>
  (await lateLinesOf(orderId)).map((line) => line.event);

// the lock the app takes for a payment while it changes the state of its refund
export const lockLateRefund = async (tx: Prisma.TransactionClient, paymentId: string) => {
  await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${lateRefundLockKey(paymentId)}))`;
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
  type: 'refund.updated' | 'refund.failed',
  refund: {
    id: string;
    paymentId: string;
    status: 'succeeded' | 'pending' | 'failed' | 'canceled';
    reason?: string;
    // the key of the app rides in the metadata; none for a refund made by hand
    metadata?: Record<string, string>;
  },
) {
  return craftEvent(type, {
    object: 'refund',
    id: refund.id,
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

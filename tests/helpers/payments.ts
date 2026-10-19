import type { FastifyInstance } from 'fastify';
import { jest } from '@jest/globals';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { getRedis } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';

import { accessCookie } from './actors.js';
import { withCsrf, type Csrf } from './csrf.js';
import { asAdmin } from './db.js';
import type { TestProduct, TestUser } from './factories.js';
import { placeOrder, shippingData } from './orders.js';
import { payByCard, payCheckoutSession, rememberSession, stripeEvent } from './stripe.js';

export const CHECKOUT_URL = '/api/payments/checkout/sessions';

// the payment page of an order, the way the frontend asks for one
export const checkout = (app: FastifyInstance, csrf: Csrf, user: TestUser, orderId: unknown) =>
  app.inject({
    method: 'POST',
    url: CHECKOUT_URL,
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { orderId },
  });

// a payment page the app opened for the order; returns its id
export async function openPaymentPage(
  app: FastifyInstance,
  csrf: Csrf,
  user: TestUser,
  orderId: number,
): Promise<string> {
  const res = await checkout(app, csrf, user, orderId);
  if (res.statusCode !== 201) {
    throw new Error(`opening the payment page answered ${res.statusCode}`);
  }

  return rememberSession(res.json().checkoutSession.sessionId);
}

// an order Stripe really took the money for: a test card payment of its total, recorded by the
// database function the webhook calls (the page and its webhook are tested in api/payments).
// Returns the order and its payment
export async function placePaidOrder(
  app: FastifyInstance,
  csrf: Csrf,
  user: TestUser,
  product: TestProduct,
  opts: { quantity?: number; stage?: 'paid' | 'shipped' } = {},
): Promise<{ orderId: number; paymentId: string }> {
  const orderId = await placeOrder(app, csrf, user, product, 'waiting', opts.quantity ?? 1);

  const { total } = await asAdmin((tx) =>
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } }),
  );
  const paymentId = await payByCard(Math.round(Number(total) * 100));

  const paid = await asAdmin(
    (tx) => tx.$queryRaw<{ result: string }[]>`
      select cartlify.pay_order(${orderId}::int, ${paymentId}, ${total}::numeric) as result
    `,
  );
  if (paid[0]?.result !== 'PAID') throw new Error(`paying the order answered ${paid[0]?.result}`);

  if (opts.stage === 'shipped') {
    await asAdmin((tx) => tx.order.update({ where: { id: orderId }, data: { status: 'shipped' } }));
  }
  return { orderId, paymentId };
}

// the buyer pays on the page; returns the payment and the event Stripe recorded for it
export async function payPage(sessionId: string) {
  const paymentId = await payCheckoutSession(sessionId);
  const event = await stripeEvent('checkout.session.completed', sessionId);

  return { paymentId, event };
}

// an order waiting for its payment, confirmed by the database function itself, past the checks of
// the confirm route: an order confirmed before a rule of the route was there (a total below the
// smallest payment), or with a reservation of a second that is over when this returns
export async function confirmInDatabase(
  user: TestUser,
  orderId: number,
  opts: { endedReservation?: boolean } = {},
) {
  const reserveFor = opts.endedReservation ? '1 second' : '15 minutes';

  await prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: user.id, role: 'USER' });
    await tx.order.update({ where: { id: orderId }, data: shippingData });
    await tx.$executeRaw`select cartlify.confirm_order(${orderId}::int, ${reserveFor}::interval)`;
  });
  if (opts.endedReservation) await new Promise((resolve) => setTimeout(resolve, 1_100));
}

// only the owner deletes an order that is not confirmed, its items go with it
export const deleteOrderAsOwner = (user: TestUser, orderId: number) =>
  prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: user.id, role: 'USER' });
    await tx.order.deleteMany({ where: { id: orderId } });
  });

// what the order timeout worker keeps for the order in redis
export async function redisStateOf(orderId: number) {
  const redis = await getRedis();

  return {
    pageLink: await redis.hGet(redisKeys.orderPaymentSessionMap, String(orderId)),
    reservationTimer: await redis.zScore(redisKeys.orderTimeoutBaseZset, String(orderId)),
    graceTimer: await redis.zScore(redisKeys.orderTimeoutZset, String(orderId)),
  };
}

export const orderStateOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.order.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        confirmed: true,
        paymentIntentId: true,
        reservationExpiresAt: true,
        total: true,
      },
    }),
  );

export const refundAuditOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, action: 'OTHER' },
      orderBy: { id: 'asc' },
    }),
  );

// the clock of the app moved forward, for a time the test cannot wait for; restore() puts it back
export function moveClock(ms: number) {
  const realNow = Date.now.bind(Date);
  const spy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + ms);

  return { restore: () => spy.mockRestore() };
}

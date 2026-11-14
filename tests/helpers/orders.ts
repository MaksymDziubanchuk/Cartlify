import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { setAdminContext, setUserContext } from '@db/dbContext.service.js';

import { accessCookie } from './actors.js';
import { withCsrf, type Csrf } from './csrf.js';
import { asAdmin } from './db.js';
import {
  createUser,
  variantOf,
  type TestProduct,
  type TestUser,
  type VariantRef,
} from './factories.js';

import type { UserId } from 'types/ids.js';

export type OrderStage = 'cart' | 'waiting' | 'paid' | 'shipped';

// where and to whom an order goes, as a buyer sends it with the confirmation: by hand, to an address
// of a country the tests allow
export const deliveryBody = {
  method: 'manual',
  recipientFirstName: 'Anna',
  recipientLastName: 'Koval',
  recipientPhone: '+380501234567',
  address: {
    country: 'UA',
    postalCode: '01001',
    city: 'Kyiv',
    street: 'Test street',
    house: '1',
  },
};

// what a confirmation needs besides the order id: the delivery and the price of it the page
// showed. The tests set no flat price unless they say so, the delivery costs nothing then; a test
// that sets one sends the price it expects
export const shippingData = { delivery: deliveryBody, expectedDeliveryPrice: 0 };

// the price of a delivery method the page shows for an order that is not confirmed: the quote in
// the answer the order came with (the cart after an item went in, the order read). A method the
// shop has not enabled has no quote, 0 then: the confirmation refuses it for the method anyway
export function quotedDeliveryPrice(
  order: { deliveryQuotes?: { method: string; price: number }[] },
  method = 'manual',
): number {
  return order.deliveryQuotes?.find((quote) => quote.method === method)?.price ?? 0;
}

// the same delivery as an order answers with it, the price and the rest left to the test
export const deliveryAnswer = {
  method: 'manual',
  recipient: { firstName: 'Anna', lastName: 'Koval', phone: '+380501234567' },
  address: {
    country: 'UA',
    postalCode: '01001',
    city: 'Kyiv',
    street: 'Test street',
    house: '1',
    apartment: null,
  },
};

// what a test buys: a product made by createProduct (its first variant, the one it has), a variant by
// its id ({ variantId }, also a second variant of a product), or the id of a product (its first
// variant). The cart takes the id of a variant
export type Buyable = TestProduct | VariantRef | number;

export async function variantIdOf(item: Buyable): Promise<number> {
  if (typeof item === 'number') return (await variantOf(item)).id;
  return item.variantId;
}

// an order of the user taken as far as the stage, the way the app takes it there: the cart and the
// confirmation go through the api, the payment through the database function the stripe webhook
// calls (a made-up payment id), the shipping as an admin. Returns the order id
export const placeOrder = (
  app: FastifyInstance,
  csrf: Csrf,
  user: TestUser,
  product: Buyable,
  stage: OrderStage,
  quantity = 1,
  // where the order goes, when a test needs it other than the usual one
  delivery: Record<string, unknown> = deliveryBody,
): Promise<number> => placeOrderOf(app, csrf, user, [{ item: product, quantity }], stage, delivery);

// what an order holds: a variant (or a product, meaning its first variant) and how many of it
export type OrderLine = { item: Buyable; quantity?: number };

// the same for an order of several lines, the variants of one product among them
export async function placeOrderOf(
  app: FastifyInstance,
  csrf: Csrf,
  user: TestUser,
  lines: OrderLine[],
  stage: OrderStage,
  delivery: Record<string, unknown> = deliveryBody,
): Promise<number> {
  const headers = withCsrf(csrf, accessCookie(user));

  let added;
  for (const line of lines) {
    added = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers,
      payload: { variantId: await variantIdOf(line.item), quantity: line.quantity ?? 1 },
    });
    if (added.statusCode !== 200) {
      throw new Error(`adding to the cart answered ${added.statusCode}`);
    }
  }
  if (!added) throw new Error('an order needs at least one line');

  const { id: orderId } = await asAdmin((tx) =>
    tx.order.findFirstOrThrow({
      where: { userId: user.id, confirmed: false },
      orderBy: { id: 'desc' },
      select: { id: true },
    }),
  );
  if (stage === 'cart') return orderId;

  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers,
    payload: {
      orderId,
      delivery,
      expectedDeliveryPrice: quotedDeliveryPrice(
        added.json(),
        typeof delivery.method === 'string' ? delivery.method : undefined,
      ),
    },
  });
  if (confirmed.statusCode !== 200) {
    throw new Error(`confirming the order answered ${confirmed.statusCode}`);
  }
  if (stage === 'waiting') return orderId;

  await payOrder(orderId);
  if (stage === 'paid') return orderId;

  await asAdmin((tx) => tx.order.update({ where: { id: orderId }, data: { status: 'shipped' } }));
  return orderId;
}

// the payment the stripe webhook records for an order that waits for it, a made-up payment id;
// the confirmation may refresh the prices, the payment has to match the items as they are now
export async function payOrder(orderId: number): Promise<void> {
  const paid = await asAdmin(async (tx) => {
    const { total } = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { total: true },
    });

    return tx.$queryRaw<{ result: string }[]>`
      select cartlify.pay_order(${orderId}::int, 'stripe'::cartlify."PaymentProvider", ${`pi_test_${orderId}`}, ${total}::numeric) as result
    `;
  });
  if (paid[0]?.result !== 'PAID') throw new Error(`paying the order answered ${paid[0]?.result}`);
}

// what the reservation timer does when the payment does not come in time: the order waiting for
// its payment becomes unconfirmed, with its items and shipping data
export const loseReservation = (orderId: number) =>
  asAdmin((tx) => tx.$executeRaw`select cartlify.unconfirm_order(${orderId}::int)`);

// an order of the user that lost its reservation
export async function placeUnconfirmedOrder(
  app: FastifyInstance,
  csrf: Csrf,
  user: TestUser,
  product: Buyable,
  quantity = 1,
): Promise<number> {
  const orderId = await placeOrder(app, csrf, user, product, 'waiting', quantity);
  await loseReservation(orderId);
  return orderId;
}

// the admin in whose name the helpers write what the shop pays a carrier when the test names none:
// the money journal keeps the actor of every line, and the system may not write a cost
let costAdmin: Promise<TestUser> | null = null;
const costAdminOf = () => (costAdmin ??= createUser({ role: 'ADMIN' }));

// a send of the order the way an admin records it, written straight into the database: the order is
// shipped already or the test moves it. Its cost is a line of the money journal, written by the
// function the routes call (record_order_shipment_cost) in the name of an admin (by, or one of the
// helper); a cost of 0 writes no line
export const addShipment = async (
  orderId: number,
  fields: {
    carrier?: string | null;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
    cost?: number | null;
    expense?: boolean;
    // the status went back from shipped: the send stays as history
    rolledBack?: boolean;
    // the admin who writes the cost
    by?: number;
  } = {},
) => {
  const by = fields.cost ? (fields.by ?? (await costAdminOf()).id) : null;

  return asAdmin(async (tx) => {
    // the policy takes a send of a shipped order on its way, the flags come after it
    const send = await tx.orderShipment.create({
      data: {
        orderId,
        carrier: fields.carrier ?? null,
        trackingNumber: fields.trackingNumber ?? null,
        trackingUrl: fields.trackingUrl ?? null,
      },
    });
    if (by !== null) {
      await setUserContext(tx, { userId: by as UserId, role: 'ADMIN' });
      await tx.$queryRaw`select cartlify.record_order_shipment_cost(${send.id}::int, ${fields.cost}::numeric) as result`;
      await setAdminContext(tx);
    }
    if (fields.expense === false || fields.rolledBack) {
      return tx.orderShipment.update({
        where: { id: send.id },
        data: {
          ...(fields.expense === false ? { expense: false } : {}),
          ...(fields.rolledBack ? { rolledBackAt: new Date(Date.now() + 60_000) } : {}),
        },
      });
    }
    return send;
  });
};

export const orderRowOf = (orderId: number) =>
  asAdmin((tx) => tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } }));

// the lines of the money journal of what the shop pays the carrier for a send, the oldest first:
// the first cost, then each correction with the difference
export const shippingLinesOf = (shipmentId: number) =>
  asAdmin(async (tx) =>
    (
      await tx.moneyLog.findMany({
        where: { orderShipmentId: shipmentId, purpose: 'shipping' },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          event: true,
          amount: true,
          coversId: true,
          orderId: true,
          actorId: true,
          actorRole: true,
        },
      })
    ).map((line) => ({ ...line, amount: Number(line.amount) })),
  );

// what the shop pays the carrier for a send: the sum of its lines, none while none is written
export async function shippingCostOf(shipmentId: number): Promise<number | null> {
  const lines = await shippingLinesOf(shipmentId);
  if (lines.length === 0) return null;

  return -lines.reduce((sum, line) => sum + Math.round(line.amount * 100), 0) / 100 || 0;
}

// the payment of an order, as the provider names it (the webhook writes it with the payment)
const paymentIdOf = async (orderId: number) => {
  const { paymentId } = await asAdmin((tx) =>
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentId: true } }),
  );
  if (!paymentId) throw new Error(`the order ${orderId} has no payment`);
  return paymentId;
};

// what the system does when the provider reviews the payment of a paid order: it holds the order
// from its sending (db/05 hold_payment_review) until the review is over (release_payment_review);
// the id of the review
export async function holdForReview(orderId: number, reviewId = `prv_${randomUUID()}`) {
  const paymentId = await paymentIdOf(orderId);
  await asAdmin(
    (tx) => tx.$queryRaw`select cartlify.hold_payment_review(${paymentId}, ${reviewId}) as result`,
  );
  return reviewId;
}

export async function releaseReview(orderId: number, reviewId: string) {
  const paymentId = await paymentIdOf(orderId);
  await asAdmin(
    (tx) =>
      tx.$queryRaw`select cartlify.release_payment_review(${paymentId}, ${reviewId}) as result`,
  );
}

// what the system does when the provider warns that the payment of an order may be fraud: a paid
// order is held from its sending, a sent one only marked (fraudWarnedAt, db/05 hold_fraud_warning);
// the id of the warning
export async function warnOfFraud(orderId: number, warningId = `issfr_${randomUUID()}`) {
  const paymentId = await paymentIdOf(orderId);
  await asAdmin(
    (tx) => tx.$queryRaw`select cartlify.hold_fraud_warning(${paymentId}, ${warningId}) as result`,
  );
  return warningId;
}

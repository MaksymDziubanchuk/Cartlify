import type { FastifyInstance } from 'fastify';

import { accessCookie } from './actors.js';
import { withCsrf, type Csrf } from './csrf.js';
import { asAdmin } from './db.js';
import type { TestProduct, TestUser } from './factories.js';

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

// an order of the user taken as far as the stage, the way the app takes it there: the cart and the
// confirmation go through the api, the payment through the database function the stripe webhook
// calls (a made-up payment id), the shipping as an admin. Returns the order id
export async function placeOrder(
  app: FastifyInstance,
  csrf: Csrf,
  user: TestUser,
  product: TestProduct,
  stage: OrderStage,
  quantity = 1,
  // where the order goes, when a test needs it other than the usual one
  delivery: Record<string, unknown> = deliveryBody,
): Promise<number> {
  const headers = withCsrf(csrf, accessCookie(user));

  const added = await app.inject({
    method: 'POST',
    url: '/api/orders/current/items',
    headers,
    payload: { productId: product.id, quantity },
  });
  if (added.statusCode !== 200) throw new Error(`adding to the cart answered ${added.statusCode}`);

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
  product: TestProduct,
  quantity = 1,
): Promise<number> {
  const orderId = await placeOrder(app, csrf, user, product, 'waiting', quantity);
  await loseReservation(orderId);
  return orderId;
}

// a send of the order the way an admin records it, written straight into the database: the order is
// shipped already or the test moves it
export const addShipment = (
  orderId: number,
  fields: {
    carrier?: string | null;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
    cost?: number | null;
    expense?: boolean;
    // the status went back from shipped: the send stays as history
    rolledBack?: boolean;
  } = {},
) =>
  asAdmin(async (tx) => {
    // the policy takes a send of a shipped order on its way, the flags come after it
    const send = await tx.orderShipment.create({
      data: {
        orderId,
        carrier: fields.carrier ?? null,
        trackingNumber: fields.trackingNumber ?? null,
        trackingUrl: fields.trackingUrl ?? null,
        cost: fields.cost ?? null,
      },
    });
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

export const orderRowOf = (orderId: number) =>
  asAdmin((tx) => tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } }));

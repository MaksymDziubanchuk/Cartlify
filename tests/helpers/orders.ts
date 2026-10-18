import type { FastifyInstance } from 'fastify';

import { accessCookie } from './actors.js';
import { withCsrf, type Csrf } from './csrf.js';
import { asAdmin } from './db.js';
import type { TestProduct, TestUser } from './factories.js';

export type OrderStage = 'cart' | 'waiting' | 'paid' | 'shipped';

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
    payload: { orderId, shippingAddress: 'Test street 1, Kyiv' },
  });
  if (confirmed.statusCode !== 200) {
    throw new Error(`confirming the order answered ${confirmed.statusCode}`);
  }
  if (stage === 'waiting') return orderId;

  // the confirmation may refresh the prices, the payment has to match the items as they are now
  const paid = await asAdmin(async (tx) => {
    const { total } = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { total: true },
    });

    return tx.$queryRaw<{ result: string }[]>`
      select cartlify.pay_order(${orderId}::int, ${`pi_test_${orderId}`}, ${total}::numeric) as result
    `;
  });
  if (paid[0]?.result !== 'PAID') throw new Error(`paying the order answered ${paid[0]?.result}`);
  if (stage === 'paid') return orderId;

  await asAdmin((tx) => tx.order.update({ where: { id: orderId }, data: { status: 'shipped' } }));
  return orderId;
}

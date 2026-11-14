import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  setProductPrice,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  holdForReview,
  loseReservation,
  payOrder,
  placeOrder,
  placeUnconfirmedOrder,
  shippingData,
  warnOfFraud,
} from '../../../helpers/orders.js';
import { markVariantDeleted } from '../../../helpers/variants.js';

// GET /api/orders: the order history. The cart is not an order and is not listed; the newest come
// first. A paid order shows what was paid, an unconfirmed one what confirming it again would cost

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const newProduct = async (opts: { stock?: number; price?: number } = {}) => {
  const product = await createProduct({ price: 10, stock: 20, ...opts });
  products.push(product);
  return product;
};

const list = (user: TestUser, query = '') =>
  app.inject({
    method: 'GET',
    url: `/api/orders${query}`,
    headers: { cookie: accessCookie(user) },
  });

type ListedOrder = {
  id: number;
  status: string;
  total: number;
  paidAt?: string;
  items: {
    product: { id: number };
    variant: { id: number; forSale: boolean };
    unitPrice: number;
  }[];
};

const idsOf = (res: { json: () => { items: ListedOrder[] } }) =>
  res.json().items.map((order) => order.id);

const listed = (res: { json: () => { items: ListedOrder[] } }, id: number) => {
  const order = res.json().items.find((it) => it.id === id);
  if (!order) throw new Error(`the list has no order ${id}`);
  return order;
};

// an order of several variants that lost its reservation
async function unconfirmedOrderOf(user: TestUser, variantIds: number[]): Promise<number> {
  let orderId = 0;
  for (const variantId of variantIds) {
    const added = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { variantId, quantity: 1 },
    });
    orderId = added.json().id;
  }

  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { orderId, ...shippingData },
  });
  if (confirmed.statusCode !== 200) throw new Error(`confirm answered ${confirmed.statusCode}`);

  await loseReservation(orderId);
  return orderId;
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('GET /api/orders', () => {
  it('lists the orders of the user, the newest first, without the cart', async () => {
    const user = await newUser();
    const product = await newProduct();
    const paidId = await placeOrder(app, csrf, user, product, 'paid');
    const waitingId = await placeOrder(app, csrf, user, product, 'waiting');
    const unconfirmedId = await placeUnconfirmedOrder(app, csrf, user, product);
    const cartId = await placeOrder(app, csrf, user, product, 'cart');

    const res = await list(user);

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([unconfirmedId, waitingId, paidId]);
    expect(idsOf(res)).not.toContain(cartId);
    expect(res.json()).toMatchObject({ total: 3, limit: 20, nextCursor: null });
  });

  it('shows a user none of the orders of another user', async () => {
    const owner = await newUser();
    await placeOrder(app, csrf, owner, await newProduct(), 'paid');

    const res = await list(await newUser());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], total: 0 });
  });

  it('lets an admin see the orders of every user, without any cart', async () => {
    const product = await newProduct();
    const first = await placeOrder(app, csrf, await newUser(), product, 'waiting');
    const second = await placeOrder(app, csrf, await newUser(), product, 'paid');
    const cartId = await placeOrder(app, csrf, await newUser(), product, 'cart');

    const res = await list(await newUser({ role: 'ADMIN' }), '?limit=100');

    expect(res.statusCode).toBe(200);
    // other test files make orders at the same time, only the ones of this test are compared
    expect(idsOf(res).filter((id) => id === first || id === second)).toEqual([second, first]);
    expect(idsOf(res)).not.toContain(cartId);
    expect(res.json().items.every((order: ListedOrder) => order.status !== 'pending')).toBe(true);
  });

  it('filters by status and by confirmation', async () => {
    const user = await newUser();
    const product = await newProduct();
    const paidId = await placeOrder(app, csrf, user, product, 'paid');
    const unconfirmedId = await placeUnconfirmedOrder(app, csrf, user, product);
    await placeOrder(app, csrf, user, product, 'cart');

    expect(idsOf(await list(user, '?status=unconfirmed'))).toEqual([unconfirmedId]);
    expect(idsOf(await list(user, '?status=paid'))).toEqual([paidId]);
    // the cart is not confirmed either, it still stays out
    expect(idsOf(await list(user, '?confirmed=false'))).toEqual([unconfirmedId]);
  });

  it('refuses a filter by the cart status', async () => {
    const res = await list(await newUser(), '?status=pending');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('pages through the orders with the cursor, each order once', async () => {
    const user = await newUser();
    const product = await newProduct();
    const oldest = await placeOrder(app, csrf, user, product, 'paid');
    const middle = await placeOrder(app, csrf, user, product, 'paid');
    const newest = await placeOrder(app, csrf, user, product, 'waiting');

    const first = await list(user, '?limit=2');
    expect(idsOf(first)).toEqual([newest, middle]);
    expect(first.json().nextCursor).toEqual(expect.any(String));

    const second = await list(user, `?limit=2&cursor=${first.json().nextCursor}`);
    expect(idsOf(second)).toEqual([oldest]);
    expect(second.json().nextCursor).toBeNull();
  });

  it('lists by the time of creation by default, also when an older order changed later', async () => {
    const user = await newUser();
    const product = await newProduct();
    const older = await placeOrder(app, csrf, user, product, 'waiting');
    const newer = await placeOrder(app, csrf, user, product, 'waiting');
    // the older order changes last
    await payOrder(older);

    expect(idsOf(await list(user))).toEqual([newer, older]);
  });

  describe('the time of the payment', () => {
    // two orders paid the other way round to how they were made, one not paid
    async function paidTheOtherWayRound(user: TestUser) {
      const product = await newProduct();
      const paidLast = await placeOrder(app, csrf, user, product, 'waiting');
      const paidFirst = await placeOrder(app, csrf, user, product, 'waiting');
      const notPaid = await placeUnconfirmedOrder(app, csrf, user, product);
      await payOrder(paidFirst);
      await payOrder(paidLast);
      return { paidFirst, paidLast, notPaid };
    }

    it('sorts the paid orders by the time of their payment and leaves out the ones not paid', async () => {
      const user = await newUser();
      const { paidFirst, paidLast } = await paidTheOtherWayRound(user);

      const newest = await list(user, '?sortBy=paidAt');
      const oldest = await list(user, '?sortBy=paidAt&sortDir=asc');

      expect(newest.statusCode).toBe(200);
      expect(idsOf(newest)).toEqual([paidLast, paidFirst]);
      expect(newest.json().total).toBe(2);
      expect(idsOf(oldest)).toEqual([paidFirst, paidLast]);
      const [last, first] = newest.json().items as ListedOrder[];
      expect(Date.parse(last!.paidAt!)).toBeGreaterThan(Date.parse(first!.paidAt!));
    });

    it('pages by the time of the payment with the cursor, each order once', async () => {
      const user = await newUser();
      const { paidFirst, paidLast } = await paidTheOtherWayRound(user);

      const first = await list(user, '?sortBy=paidAt&limit=1');
      const second = await list(user, `?sortBy=paidAt&limit=1&cursor=${first.json().nextCursor}`);

      expect(idsOf(first)).toEqual([paidLast]);
      expect(idsOf(second)).toEqual([paidFirst]);
      expect(second.json().nextCursor).toBeNull();
    });

    it('lists the orders paid in a period, from its start and before its end', async () => {
      const user = await newUser();
      const { paidFirst, paidLast } = await paidTheOtherWayRound(user);
      const byPayment = (await list(user, '?sortBy=paidAt&sortDir=asc')).json().items;
      const [firstAt, lastAt] = byPayment.map((order: ListedOrder) => order.paidAt);
      expect(Date.parse(lastAt)).toBeGreaterThan(Date.parse(firstAt));

      const fromLast = await list(user, `?paidFrom=${lastAt}`);
      const beforeLast = await list(user, `?paidTo=${lastAt}`);
      const justAfterLast = new Date(Date.parse(lastAt) + 1).toISOString();
      const both = await list(user, `?paidFrom=${firstAt}&paidTo=${justAfterLast}`);

      expect(idsOf(fromLast)).toEqual([paidLast]);
      expect(idsOf(beforeLast)).toEqual([paidFirst]);
      expect(idsOf(both).sort()).toEqual([paidFirst, paidLast].sort());
      expect(both.json().total).toBe(2);
    });

    it.each([
      ['ends before it starts', '2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
      ['ends where it starts', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    ])('refuses a period of the payment that %s', async (_case, from, to) => {
      const res = await list(await newUser(), `?paidFrom=${from}&paidTo=${to}`);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PAID_PERIOD_INVALID' });
    });

    it.each(['paidFrom=yesterday', 'paidTo=2026-13-01'])(
      'refuses %s as the time of the payment',
      async (query) => {
        const res = await list(await newUser(), `?${query}`);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      },
    );
  });

  it('sorts by the total when asked', async () => {
    const user = await newUser();
    const dear = await placeOrder(app, csrf, user, await newProduct({ price: 30 }), 'paid');
    const cheap = await placeOrder(app, csrf, user, await newProduct({ price: 5 }), 'paid');

    const res = await list(user, '?sortBy=total&sortDir=asc');

    expect(idsOf(res)).toEqual([cheap, dear]);
  });

  it('keeps the price a paid order was paid with and shows an unconfirmed one at the new price', async () => {
    const user = await newUser();
    const product = await newProduct({ price: 10 });
    const paidId = await placeOrder(app, csrf, user, product, 'paid');
    const unconfirmedId = await placeUnconfirmedOrder(app, csrf, user, product);
    await setProductPrice(product.id, 15);

    const res = await list(user);

    expect(listed(res, paidId)).toMatchObject({ total: 10, items: [{ unitPrice: 10 }] });
    expect(listed(res, unconfirmedId)).toMatchObject({ total: 15, items: [{ unitPrice: 15 }] });
  });

  it('drops the items of deleted products from an unconfirmed order, a paid one keeps them', async () => {
    const user = await newUser();
    const gone = await newProduct({ price: 10 });
    const kept = await newProduct({ price: 4 });
    const paidId = await placeOrder(app, csrf, user, gone, 'paid');
    const unconfirmedId = await unconfirmedOrderOf(user, [gone.variantId, kept.variantId]);
    await deleteProductFromCatalog(gone.id);

    const res = await list(user);

    expect(listed(res, unconfirmedId)).toMatchObject({
      total: 4,
      items: [{ variant: { id: kept.variantId } }],
    });
    expect(listed(res, unconfirmedId).items).toHaveLength(1);
    // the paid order keeps the position and says the variant is not for sale
    expect(listed(res, paidId)).toMatchObject({
      total: 10,
      items: [{ variant: { id: gone.variantId, forSale: false } }],
    });
  });

  it('drops the position of a variant taken out of sale from an unconfirmed order, a paid one keeps it', async () => {
    const user = await newUser();
    const product = await newProduct({ price: 10 });
    const sibling = await createVariant(product.id, { price: 4, stock: 5 });
    const paidId = await placeOrder(app, csrf, user, product, 'paid');
    const unconfirmedId = await unconfirmedOrderOf(user, [product.variantId, sibling.id]);
    await markVariantDeleted(product.variantId);

    const res = await list(user);

    expect(listed(res, unconfirmedId).items).toHaveLength(1);
    expect(listed(res, unconfirmedId)).toMatchObject({
      total: 4,
      items: [{ variant: { id: sibling.id, forSale: true } }],
    });
    expect(listed(res, paidId)).toMatchObject({
      items: [{ variant: { id: product.variantId, forSale: false } }],
    });
  });

  it('never gives the payment id', async () => {
    const user = await newUser();
    await placeOrder(app, csrf, user, await newProduct(), 'paid');

    const res = await list(user);

    expect(res.json().items[0]).not.toHaveProperty('paymentId');

    expect(res.json().items[0]).not.toHaveProperty('paymentProvider');
  });

  it('refuses a guest', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/orders' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

// orders.holds: what keeps a paid order from its sending (a dispute, a refund by hand root has not
// decided on, a warning or a review of the provider), and orders.fraudWarnedAt: a warning of the
// provider about an order already sent. The desk of an admin lists them; the alerts list them by the
// same filters (the paid orders that wait to be sent are the ones nothing holds)
describe('GET /api/orders: what holds the orders (admin and root)', () => {
  let admin: TestUser;

  beforeAll(async () => {
    admin = await newUser({ role: 'ADMIN' });
  });

  const sortedIdsOf = (res: { json: () => { items: ListedOrder[] } }) =>
    idsOf(res).sort((a, b) => a - b);

  // the orders of one buyer: a paid one nothing holds, one the provider reviews, one it warned of,
  // one held for both, and one already sent
  async function heldOrders() {
    const buyer = await newUser();
    const product = await newProduct();
    const free = await placeOrder(app, csrf, buyer, product, 'paid');
    const reviewed = await placeOrder(app, csrf, buyer, product, 'paid');
    const warned = await placeOrder(app, csrf, buyer, product, 'paid');
    const both = await placeOrder(app, csrf, buyer, product, 'paid');
    const sent = await placeOrder(app, csrf, buyer, product, 'shipped');
    await holdForReview(reviewed);
    await warnOfFraud(warned);
    await holdForReview(both);
    await warnOfFraud(both);
    return { buyer, free, reviewed, warned, both, sent };
  }

  it('lists the orders a reason holds, a few reasons through commas', async () => {
    const o = await heldOrders();
    const held = (holds: string) => list(admin, `?userId=${o.buyer.id}&holds=${holds}`);

    expect(sortedIdsOf(await held('payment_review'))).toEqual([o.reviewed, o.both]);
    expect(sortedIdsOf(await held('fraud_warning'))).toEqual([o.warned, o.both]);
    expect(sortedIdsOf(await held('payment_review,fraud_warning'))).toEqual([
      o.reviewed,
      o.warned,
      o.both,
    ]);
    expect(sortedIdsOf(await held('dispute,hand_refund'))).toEqual([]);
  });

  it('lists the orders anything holds, and the ones nothing holds', async () => {
    const o = await heldOrders();

    const any = await list(admin, `?userId=${o.buyer.id}&holds=any`);
    const none = await list(admin, `?userId=${o.buyer.id}&holds=none`);
    // the paid orders that wait only for the shop to send them
    const waiting = await list(admin, `?userId=${o.buyer.id}&holds=none&statuses=paid`);

    expect(any.statusCode).toBe(200);
    expect(sortedIdsOf(any)).toEqual([o.reviewed, o.warned, o.both]);
    expect(any.json().total).toBe(3);
    expect(sortedIdsOf(none)).toEqual([o.free, o.sent]);
    expect(sortedIdsOf(waiting)).toEqual([o.free]);
  });

  it.each(['paid', 'any,dispute', 'none,payment_review', 'dispute,,hand_refund', ''])(
    'refuses holds=%s by the request schema',
    async (holds) => {
      const res = await list(admin, `?holds=${holds}`);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    },
  );

  // the database sets the time of the warning: the period is taken with a minute to spare
  it('lists the orders the provider warned of after they were sent, from a time', async () => {
    const buyer = await newUser();
    const product = await newProduct();
    const sent = await placeOrder(app, csrf, buyer, product, 'shipped');
    const quiet = await placeOrder(app, csrf, buyer, product, 'shipped');
    // a paid order is held instead of marked
    const held = await placeOrder(app, csrf, buyer, product, 'paid');
    await warnOfFraud(sent);
    await warnOfFraud(held);

    const before = new Date(Date.now() - 60_000).toISOString();
    const after = new Date(Date.now() + 60_000).toISOString();
    const since = await list(admin, `?userId=${buyer.id}&fraudWarnedFrom=${before}`);
    const later = await list(admin, `?userId=${buyer.id}&fraudWarnedFrom=${after}`);

    expect(since.statusCode).toBe(200);
    expect(idsOf(since)).toEqual([sent]);
    expect(idsOf(later)).toEqual([]);
    expect(idsOf(since)).not.toContain(quiet);
  });

  it.each([
    ['holds', 'holds=any'],
    ['fraudWarnedFrom', 'fraudWarnedFrom=2026-01-01T00:00:00.000Z'],
  ])('refuses the filter %s to a buyer', async (filter, query) => {
    const res = await list(await newUser(), `?${query}`);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'FILTER_FORBIDDEN', details: { filter } });
  });
});

// the card of an order an admin opens: what holds it, the warning of an order already sent, and
// the money of the order from the money journal, short (the whole lines are the money journal of
// the admins); the buyer sees none of it
describe('GET /api/orders/:orderId: what holds the order and its money (admin and root)', () => {
  let admin: TestUser;

  beforeAll(async () => {
    admin = await newUser({ role: 'ADMIN' });
  });

  const cardOf = (actor: TestUser, orderId: number) =>
    app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(actor) },
    });

  const nearNow = (iso: string) => Math.abs(Date.parse(iso) - Date.now()) < 60_000;

  it('gives the admin what holds the order, since when and what put it, and the buyer none of it', async () => {
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, await newProduct(), 'paid');
    const reviewId = await holdForReview(orderId);

    const adminCard = await cardOf(admin, orderId);
    const buyerCard = await cardOf(buyer, orderId);

    expect(adminCard.statusCode).toBe(200);
    expect(adminCard.json().holds).toEqual([
      { reason: 'payment_review', since: expect.any(String), ref: reviewId },
    ]);
    expect(nearNow(adminCard.json().holds[0].since)).toBe(true);
    expect(adminCard.json()).not.toHaveProperty('fraudWarnedAt');
    expect(buyerCard.statusCode).toBe(200);
    for (const field of ['holds', 'fraudWarnedAt', 'money']) {
      expect(buyerCard.json()).not.toHaveProperty(field);
    }
  });

  it('gives the time the provider warned of an order already sent, and no hold for it', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'shipped');
    await warnOfFraud(orderId);

    const res = await cardOf(admin, orderId);

    expect(res.json().holds).toEqual([]);
    expect(nearNow(res.json().fraudWarnedAt)).toBe(true);
  });

  it('gives the money of the order from the journal, the oldest first, in the list too', async () => {
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, await newProduct({ price: 12 }), 'paid');
    const shipped = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { status: 'shipped', shipment: { carrier: 'DHL', cost: 7 } },
    });
    expect(shipped.statusCode).toBe(200);

    const card = await cardOf(admin, orderId);
    const row = listed(await list(admin, `?userId=${buyer.id}`), orderId) as unknown as {
      money: unknown;
    };

    const money = [
      {
        id: expect.any(Number),
        event: 'money.payment',
        purpose: 'order',
        part: 'goods',
        amount: 12,
        state: null,
        createdAt: expect.any(String),
      },
      {
        id: expect.any(Number),
        event: 'money.shipping_cost',
        purpose: 'shipping',
        part: 'whole',
        amount: -7,
        state: null,
        createdAt: expect.any(String),
      },
    ];
    expect(card.json().money).toEqual(money);
    expect(row.money).toEqual(money);
    expect(nearNow(card.json().money[0].createdAt)).toBe(true);
    // the step answers with the card of the admin as well
    expect(shipped.json().money).toEqual(money);
  });
});

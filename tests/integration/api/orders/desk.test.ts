import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import {
  holdForReview,
  placeOrder,
  placeOrderOf,
  shippingCostOf,
  shippingLinesOf,
} from '../../../helpers/orders.js';

// the desk of the orders of an admin: the steps shipped and delivered go to the admin log and a
// double click mails once; the list finds orders by the buyer, the statuses, the text of a buyer
// or a recipient and the product, names the buyer in each row, gives a csv for the courier; a step
// goes for many orders at once, each with its own answer. Other files make orders at the same time:
// a test looks only at the orders of its own buyers

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const setStatus = (orderId: number, status: string) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/status`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { status },
  });

const listAs = (actor: TestUser, query: string) =>
  app.inject({
    method: 'GET',
    url: `/api/orders?${query}`,
    headers: { cookie: accessCookie(actor) },
  });

const idsOf = (res: { json: () => { items: Array<{ id: number }> } }) =>
  res
    .json()
    .items.map((order) => order.id)
    .sort((a, b) => a - b);

const statusLinesOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, action: 'ORDER_STATUS_CHANGE' },
      orderBy: { id: 'asc' },
      select: { actorId: true, meta: true },
    }),
  );

describe('PATCH /api/orders/:orderId/status', () => {
  it('writes each step to the admin log in the name of the admin', async () => {
    const orderId = await placeOrder(
      app,
      csrf,
      await newUser(),
      await createProduct({ price: 10 }),
      'paid',
    );

    await setStatus(orderId, 'shipped');
    await setStatus(orderId, 'delivered');

    expect(await statusLinesOf(orderId)).toEqual([
      {
        actorId: admin.id,
        // shipped by hand: the send is recorded, with nothing known of it
        meta: [
          { field: 'status', old: 'paid', new: 'shipped' },
          {
            field: 'shipment',
            old: null,
            new: expect.objectContaining({ carrier: null, cost: null }),
          },
        ],
      },
      { actorId: admin.id, meta: [{ field: 'status', old: 'shipped', new: 'delivered' }] },
    ]);
  });

  // a double click: the second request read the order before the first one shipped it
  it('ships an order once when two requests come together, with one mail and one line', async () => {
    const orderId = await placeOrder(
      app,
      csrf,
      await newUser(),
      await createProduct({ price: 10 }),
      'paid',
    );
    const mails = watchMail();

    const answers = await Promise.all([
      setStatus(orderId, 'shipped'),
      setStatus(orderId, 'shipped'),
    ]);

    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const refused = answers.find((res) => res.statusCode === 409)!;
    expect(['ORDER_STATUS_CHANGED', 'ORDER_STATUS_TRANSITION_INVALID']).toContain(
      refused.json().errorCode,
    );
    expect(mails).toHaveLength(1);
    expect(await statusLinesOf(orderId)).toHaveLength(1);
  });
});

describe('GET /api/orders and its cursor', () => {
  // the cursor names its sort: one of another sort or direction starts the page from a wrong order
  it.each([
    ['another direction', 'sortBy=createdAt&sortDir=asc'],
    ['another sort', 'sortBy=updatedAt&sortDir=desc'],
  ])('refuses the cursor of %s', async (_case, other) => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 5 });
    await placeOrder(app, csrf, buyer, product, 'paid');
    await placeOrder(app, csrf, buyer, product, 'paid');
    const first = await listAs(buyer, 'sortBy=createdAt&sortDir=desc&limit=1');

    const res = await listAs(buyer, `${other}&limit=1&cursor=${first.json().nextCursor}`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });
});

describe('GET /api/orders for an admin', () => {
  // three orders of one buyer: paid, shipped and waiting for its payment, each of its own product
  async function buyerWithOrders() {
    const tag = uniqueTag().replace(/[^0-9]/g, '');
    const buyer = await newUser({ name: 'Olena', email: `olena-${tag}@example.com` });
    const names = [`Lamp ${tag}`, `Mug ${tag}`, `Vase ${tag}`];
    const products = [
      await createProduct({ price: 10, name: names[0] }),
      await createProduct({ price: 12, name: names[1] }),
      await createProduct({ price: 14, name: names[2] }),
    ];
    const paid = await placeOrder(app, csrf, buyer, products[0]!, 'paid');
    const shipped = await placeOrder(app, csrf, buyer, products[1]!, 'shipped');
    const waiting = await placeOrder(app, csrf, buyer, products[2]!, 'waiting');
    return { buyer, tag, names, products, paid, shipped, waiting };
  }

  it('lists the orders of one buyer', async () => {
    const { buyer, paid, shipped, waiting } = await buyerWithOrders();

    const res = await listAs(admin, `userId=${buyer.id}`);

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([paid, shipped, waiting].sort((a, b) => a - b));
  });

  it('lists the orders of a few statuses', async () => {
    const { buyer, paid, shipped } = await buyerWithOrders();

    const res = await listAs(admin, `userId=${buyer.id}&statuses=paid,shipped`);

    expect(idsOf(res)).toEqual([paid, shipped].sort((a, b) => a - b));
  });

  // the time of the last change of an order is set by the database, so the time between two
  // orders is taken from its clock; the alerts send an admin to the shipped orders changed long ago
  it('lists the orders changed before a time, or from it', async () => {
    const buyer = await newUser();
    const first = await placeOrder(app, csrf, buyer, await createProduct({ price: 10 }), 'paid');
    const [{ between }] = await asAdmin(
      (tx) =>
        tx.$queryRaw<[{ between: Date }]>`select clock_timestamp() at time zone 'utc' as between`,
    );
    const second = await placeOrder(app, csrf, buyer, await createProduct({ price: 10 }), 'paid');
    const at = between.toISOString();

    expect(idsOf(await listAs(admin, `userId=${buyer.id}&updatedTo=${at}`))).toEqual([first]);
    expect(idsOf(await listAs(admin, `userId=${buyer.id}&updatedFrom=${at}`))).toEqual([second]);
  });

  it('answers UPDATED_PERIOD_INVALID for a period that ends at its start or before', async () => {
    const res = await listAs(
      admin,
      'updatedFrom=2026-10-02T00:00:00.000Z&updatedTo=2026-10-02T00:00:00.000Z',
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'UPDATED_PERIOD_INVALID' });
  });

  it('finds an order by its number, and the orders of a buyer by a part of the email', async () => {
    const { buyer, tag, paid, shipped, waiting } = await buyerWithOrders();

    // the number of the order may stand in the number of a parcel of an order of another file: the
    // orders of this buyer only
    expect(idsOf(await listAs(admin, `q=${paid}&userId=${buyer.id}`))).toEqual([paid]);
    expect(idsOf(await listAs(admin, `q=${encodeURIComponent(`lena-${tag}@exa`)}`))).toEqual(
      [paid, shipped, waiting].sort((a, b) => a - b),
    );
  });

  // % and _ are wildcards of a pattern: as a text they would match every order
  it.each(['%', '_'])('takes %s in the text as it is', async (sign) => {
    const { buyer } = await buyerWithOrders();

    const res = await listAs(admin, `userId=${buyer.id}&q=${encodeURIComponent(sign)}`);

    expect(idsOf(res)).toEqual([]);
  });

  it('finds the orders that hold a product', async () => {
    const { buyer, products, shipped } = await buyerWithOrders();

    const res = await listAs(admin, `userId=${buyer.id}&productId=${products[1]!.id}`);

    expect(idsOf(res)).toEqual([shipped]);
  });

  // the black and the white of one product are two variants: the desk finds the orders that hold
  // the variant, or any variant of the product
  it('finds the orders that hold a variant, and the orders that hold any variant of a product', async () => {
    const buyer = await newUser();
    const black = await createProduct({ price: 10, stock: 5 });
    const white = await createVariant(black.id, { price: 12, stock: 5 });
    const other = await createProduct({ price: 9, stock: 5 });
    const blackOrder = await placeOrder(app, csrf, buyer, black, 'paid');
    const whiteOrder = await placeOrder(app, csrf, buyer, { variantId: white.id }, 'paid');
    const otherOrder = await placeOrder(app, csrf, buyer, other, 'paid');

    const ofBlack = await listAs(admin, `userId=${buyer.id}&variantId=${black.variantId}`);
    const ofWhite = await listAs(admin, `userId=${buyer.id}&variantId=${white.id}`);
    const ofProduct = await listAs(admin, `userId=${buyer.id}&productId=${black.id}`);
    const both = await listAs(
      admin,
      `userId=${buyer.id}&productId=${black.id}&variantId=${white.id}`,
    );
    const mismatch = await listAs(
      admin,
      `userId=${buyer.id}&productId=${other.id}&variantId=${white.id}`,
    );

    expect(idsOf(ofBlack)).toEqual([blackOrder]);
    expect(idsOf(ofWhite)).toEqual([whiteOrder]);
    expect(idsOf(ofProduct)).toEqual([blackOrder, whiteOrder].sort((a, b) => a - b));
    expect(idsOf(both)).toEqual([whiteOrder]);
    expect(idsOf(mismatch)).toEqual([]);
    expect(otherOrder).toBeGreaterThan(0);
  });

  it('finds the orders of a variant that holds more than one variant of the product', async () => {
    const buyer = await newUser();
    const black = await createProduct({ price: 10, stock: 5 });
    const white = await createVariant(black.id, { price: 12, stock: 5 });
    const both = await placeOrderOf(
      app,
      csrf,
      buyer,
      [{ item: black }, { item: { variantId: white.id } }],
      'paid',
    );

    expect(idsOf(await listAs(admin, `userId=${buyer.id}&variantId=${white.id}`))).toEqual([both]);
    expect(idsOf(await listAs(admin, `userId=${buyer.id}&variantId=${black.variantId}`))).toEqual([
      both,
    ]);
  });

  it.each(['variantId=0', 'variantId=2147483648', 'variantId=1.5', 'variantId=abc'])(
    'refuses %s',
    async (query) => {
      const res = await listAs(admin, query);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    },
  );

  it('lets a buyer filter their own orders by a variant', async () => {
    const buyer = await newUser();
    const black = await createProduct({ price: 10, stock: 5 });
    const white = await createVariant(black.id, { price: 12, stock: 5 });
    await placeOrder(app, csrf, buyer, black, 'paid');
    const whiteOrder = await placeOrder(app, csrf, buyer, { variantId: white.id }, 'paid');

    const res = await listAs(buyer, `variantId=${white.id}`);

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([whiteOrder]);
  });

  it('names the buyer in each row', async () => {
    const { buyer } = await buyerWithOrders();

    const res = await listAs(admin, `userId=${buyer.id}`);

    for (const order of res.json().items) {
      expect(order.buyer).toEqual({
        id: buyer.id,
        name: 'Olena',
        email: buyer.email,
        deleted: false,
      });
    }
  });

  it('names the buyer of a deleted account without the email', async () => {
    const root = await newUser({ role: 'ROOT' });
    const buyer = await newUser({ name: 'Olena' });
    const orderId = await placeOrder(app, csrf, buyer, await createProduct(), 'paid');
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/users/${buyer.id}`,
      headers: withCsrf(csrf, accessCookie(root)),
    });
    expect(deleted.statusCode).toBe(200);

    const res = await listAs(admin, `userId=${buyer.id}`);

    expect(res.json().items).toEqual([
      expect.objectContaining({
        id: orderId,
        buyer: { id: buyer.id, name: expect.any(String), email: null, deleted: true },
      }),
    ]);
  });

  // a buyer sees only their own orders: the filters of the desk are the admin's
  it.each(['userId=1', 'q=1', 'format=csv'])('refuses %s to a buyer', async (query) => {
    const res = await listAs(await newUser(), query);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'FILTER_FORBIDDEN' });
  });

  it('gives a buyer no buyer field', async () => {
    const { buyer } = await buyerWithOrders();

    const res = await listAs(buyer, '');

    expect(res.json().items[0]).not.toHaveProperty('buyer');
  });

  // a list to pack and hand to the courier: every order of the filters, without pages
  it('gives the orders as csv for the courier', async () => {
    const { buyer, paid, names } = await buyerWithOrders();

    const res = await listAs(admin, `userId=${buyer.id}&statuses=paid&format=csv`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    // the columns of the delivery are checked in deskDelivery.test.ts
    expect(lines[0]).toMatch(
      /^Order,Status,Return status,Paid at,Buyer email,Recipient,Phone,Method,/,
    );
    expect(lines[0]).toContain(',Items,');
    expect(lines).toHaveLength(2);
    // a paid order with no statement
    expect(lines[1]).toContain(`${paid},paid,none,`);
    expect(lines[1]).toContain(buyer.email);
    expect(lines[1]).toContain(`${names[0]} x 1`);
  });
});

describe('POST /api/orders/status', () => {
  const bulk = (payload: Record<string, unknown>, actor: TestUser = admin) =>
    app.inject({
      method: 'POST',
      url: '/api/orders/status',
      headers: withCsrf(csrf, accessCookie(actor)),
      payload,
    });

  it('ships many orders, each on its own, and names what each got', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 5 });
    const first = await placeOrder(app, csrf, buyer, product, 'paid');
    const second = await placeOrder(app, csrf, buyer, product, 'paid');
    const waiting = await placeOrder(app, csrf, buyer, product, 'waiting');
    const mails = watchMail();

    const res = await bulk({
      orders: [{ orderId: first }, { orderId: waiting }, { orderId: second }],
      status: 'shipped',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      { orderId: first, ok: true, status: 'shipped', returnStatus: 'none' },
      {
        orderId: waiting,
        ok: false,
        errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
        details: { status: 'waiting', requested: 'shipped' },
      },
      { orderId: second, ok: true, status: 'shipped', returnStatus: 'none' },
    ]);
    expect(mails).toHaveLength(2);
  });

  it('names an order that does not exist', async () => {
    const res = await bulk({ orders: [{ orderId: 2_000_000_000 }], status: 'delivered' });

    expect(res.json().results).toEqual([
      expect.objectContaining({ orderId: 2_000_000_000, ok: false, errorCode: 'ORDER_NOT_FOUND' }),
    ]);
  });

  it.each([
    ['no orders', { orders: [], status: 'shipped' }],
    ['a cancel', { orders: [{ orderId: 5 }], status: 'cancelled' }],
    ['the list of ids it had before', { orderIds: [5], status: 'shipped' }],
    [
      'an order with a send that breaks the schema',
      { orders: [{ orderId: 5, shipment: { cost: -1 } }], status: 'shipped' },
    ],
  ])('refuses %s', async (_case, payload) => {
    const res = await bulk(payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('takes an order named twice once: the second time it is shipped already', async () => {
    const orderId = await placeOrder(
      app,
      csrf,
      await newUser(),
      await createProduct({ price: 10, stock: 5 }),
      'paid',
    );

    const res = await bulk({ orders: [{ orderId }, { orderId }], status: 'shipped' });

    expect(res.json().results).toEqual([
      { orderId, ok: true, status: 'shipped', returnStatus: 'none' },
      expect.objectContaining({ orderId, ok: false, errorCode: 'ORDER_STATUS_TRANSITION_INVALID' }),
    ]);
  });

  it('ships each order with its own send, a number, a link or nothing', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 5 });
    const named = await placeOrder(app, csrf, buyer, product, 'paid');
    const bare = await placeOrder(app, csrf, buyer, product, 'paid');

    const res = await bulk({
      status: 'shipped',
      orders: [
        {
          orderId: named,
          shipment: {
            carrier: 'DHL',
            trackingNumber: 'A1',
            trackingUrl: 'https://t.example.com/A1',
            cost: 5,
          },
        },
        { orderId: bare },
      ],
    });

    expect(res.json().results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true]);
    const sends = await asAdmin((tx) =>
      tx.orderShipment.findMany({
        where: { orderId: { in: [named, bare] } },
        orderBy: { orderId: 'asc' },
      }),
    );
    expect(sends).toEqual([
      expect.objectContaining({ orderId: named, carrier: 'DHL', trackingNumber: 'A1' }),
      expect.objectContaining({ orderId: bare, carrier: null, trackingNumber: null }),
    ]);
    expect(await shippingCostOf(sends[0]!.id)).toBe(5);
    expect(await shippingCostOf(sends[1]!.id)).toBeNull();
  });

  it('names an order whose send breaks a rule and ships the others', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 5 });
    const wrong = await placeOrder(app, csrf, buyer, product, 'paid');
    const fine = await placeOrder(app, csrf, buyer, product, 'paid');

    const res = await bulk({
      status: 'shipped',
      orders: [{ orderId: wrong, shipment: { trackingNumber: 'A1' } }, { orderId: fine }],
    });

    expect(res.json().results).toEqual([
      expect.objectContaining({
        orderId: wrong,
        ok: false,
        errorCode: 'SHIPMENT_CARRIER_REQUIRED',
      }),
      { orderId: fine, ok: true, status: 'shipped', returnStatus: 'none' },
    ]);
  });

  it('takes many orders one step back, each with its own choice for the cost', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 5 });
    const kept = await placeOrder(app, csrf, buyer, product, 'paid');
    const cleared = await placeOrder(app, csrf, buyer, product, 'paid');
    await bulk({
      status: 'shipped',
      orders: [
        { orderId: kept, shipment: { carrier: 'DHL', cost: 5 } },
        { orderId: cleared, shipment: { carrier: 'DHL', cost: 5 } },
      ],
    });

    const res = await bulk({
      status: 'paid',
      orders: [
        { orderId: kept, keepShippingCost: true },
        { orderId: cleared, keepShippingCost: false },
      ],
    });

    expect(res.json().results).toEqual([
      { orderId: kept, ok: true, status: 'paid', returnStatus: 'none' },
      { orderId: cleared, ok: true, status: 'paid', returnStatus: 'none' },
    ]);
    const sends = await asAdmin((tx) =>
      tx.orderShipment.findMany({
        where: { orderId: { in: [kept, cleared] } },
        orderBy: { orderId: 'asc' },
      }),
    );
    expect(sends.map((s) => s.expense)).toEqual([true, false]);
    // the cost kept stays a line of the journal, the one taken back is corrected to nothing
    expect(await shippingCostOf(sends[0]!.id)).toBe(5);
    expect(await shippingCostOf(sends[1]!.id)).toBe(0);
    expect((await shippingLinesOf(sends[1]!.id)).map((l) => [l.event, l.amount])).toEqual([
      ['money.shipping_cost', -5],
      ['money.correction', 5],
    ]);
  });

  // an order something holds answers why, the others take the step
  it('names an order something holds and ships the others', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 5 });
    const held = await placeOrder(app, csrf, buyer, product, 'paid');
    const free = await placeOrder(app, csrf, buyer, product, 'paid');
    await holdForReview(held);
    const mails = watchMail();

    const res = await bulk({
      status: 'shipped',
      orders: [{ orderId: held, shipment: { carrier: 'DHL', cost: 5 } }, { orderId: free }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      {
        orderId: held,
        ok: false,
        errorCode: 'ORDER_ON_HOLD',
        details: { orderId: held, holds: ['payment_review'] },
      },
      { orderId: free, ok: true, status: 'shipped', returnStatus: 'none' },
    ]);
    expect(await asAdmin((tx) => tx.orderShipment.count({ where: { orderId: held } }))).toBe(0);
    expect(mails).toHaveLength(1);
  });

  it('refuses a buyer', async () => {
    const res = await bulk({ orders: [{ orderId: 5 }], status: 'shipped' }, await newUser());

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

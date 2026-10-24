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
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { placeOrder } from '../../../helpers/orders.js';

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
      { actorId: admin.id, meta: [{ field: 'status', old: 'paid', new: 'shipped' }] },
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

  it('finds an order by its number, and the orders of a buyer by a part of the email', async () => {
    const { tag, paid, shipped, waiting } = await buyerWithOrders();

    expect(idsOf(await listAs(admin, `q=${paid}`))).toEqual([paid]);
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
    expect(lines[0]).toBe('Order,Status,Paid at,Buyer email,Recipient,Phone,Address,Items,Total');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`${paid},paid,`);
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

    const res = await bulk({ orderIds: [first, waiting, second], status: 'shipped' });

    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      { orderId: first, ok: true, status: 'shipped' },
      {
        orderId: waiting,
        ok: false,
        errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
        details: { status: 'waiting', requested: 'shipped' },
      },
      { orderId: second, ok: true, status: 'shipped' },
    ]);
    expect(mails).toHaveLength(2);
  });

  it('names an order that does not exist', async () => {
    const res = await bulk({ orderIds: [2_000_000_000], status: 'delivered' });

    expect(res.json().results).toEqual([
      expect.objectContaining({ orderId: 2_000_000_000, ok: false, errorCode: 'ORDER_NOT_FOUND' }),
    ]);
  });

  it.each([
    ['no orders', { orderIds: [], status: 'shipped' }],
    ['an order named twice', { orderIds: [5, 5], status: 'shipped' }],
    ['a cancel', { orderIds: [5], status: 'cancelled' }],
  ])('refuses %s', async (_case, payload) => {
    const res = await bulk(payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a buyer', async () => {
    const res = await bulk({ orderIds: [5], status: 'shipped' }, await newUser());

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

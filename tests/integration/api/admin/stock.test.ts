import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { shopToday } from '@helpers/shopDay.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  receiveBatch,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';
import { moveClock } from '../../../helpers/payments.js';

// GET /api/admin/stock/batches and /movements: what the stock of the shop is made of and how it
// got there. A batch shows what it came in with, what is left of it, what the paid orders took and
// what was written off, the delivery it came with (the supplier, the invoice, the note and the
// admin from the admin log) and whether it is over by the day of the shop. The journal puts the
// steps of the stock in one list: the deliveries and the write-offs of the admin log, the units
// the paid orders took and the units their cancels put back. Other files make batches at the same
// time, so each test reads only its own products

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
let clock: { restore: () => void } | null = null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// a product without stock: the test takes in its own batches
const newProduct = async (price = 10) => {
  const product = await createProduct({ price, stock: 0 });
  products.push(product);
  return product;
};

const nameOf = async (productId: number) =>
  (
    await asAdmin((tx) =>
      tx.product.findUniqueOrThrow({ where: { id: productId }, select: { name: true } }),
    )
  ).name;

const dayOf = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const post = (path: string, payload: object, actor: TestUser = admin) =>
  app.inject({
    method: 'POST',
    url: `/api/products/stock/${path}`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

// a delivery through its route: the batches it took in, in the order of the items
async function deliver(payload: object, actor?: TestUser): Promise<number[]> {
  const res = await post('deliveries', payload, actor);
  if (res.statusCode !== 201) throw new Error(`the delivery answered ${res.statusCode}`);
  return res.json().batches.map((batch: { id: number }) => batch.id);
}

async function writeOff(payload: object): Promise<string> {
  const res = await post('write-offs', payload);
  if (res.statusCode !== 201) throw new Error(`the write-off answered ${res.statusCode}`);
  return res.json().writeOffId;
}

const cancelPaid = (orderId: number) =>
  asAdmin((tx) => tx.$executeRaw`select cartlify.cancel_paid_order(${orderId}::int)`);

const get = (path: string, query: Record<string, string | number | boolean>, actor = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/stock/${path}?${new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    )}`,
    headers: { cookie: accessCookie(actor) },
  });

const batches = (query: Record<string, string | number | boolean>, actor?: TestUser) =>
  get('batches', query, actor);
const movements = (query: Record<string, string | number | boolean>, actor?: TestUser) =>
  get('movements', query, actor);

// a cursor made by hand, the way a client could send one
const cursorOf = (payload: object) => Buffer.from(JSON.stringify(payload)).toString('base64url');

const idsOf = (res: { json: () => { items: { id: number }[] } }) =>
  res.json().items.map((item) => item.id);

// every page of a list, one after the other
async function walk(
  list: typeof batches,
  query: Record<string, string | number | boolean>,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const res = await list(cursor ? { ...query, cursor } : query);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    items.push(...body.items);
    cursor = body.nextCursor;
    if (!cursor) return items;
  }
  throw new Error('the list does not end');
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
});

beforeEach(() => {
  clock = null;
});

afterEach(() => {
  clock?.restore();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('GET /api/admin/stock/batches', () => {
  it('shows a batch with its delivery, what is left of it and its value', async () => {
    const product = await newProduct();
    const [batchId] = await deliver({
      source: 'supplier',
      supplier: 'Acme',
      document: 'INV-7',
      note: 'Morning truck',
      items: [
        {
          productId: product.id,
          quantity: 10,
          unitCost: 2.5,
          expiresAt: dayOf(90),
          supplierBatchNumber: 'LOT-A',
        },
      ],
    });

    const res = await batches({ productId: product.id });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ currency: 'eur', limit: 20, nextCursor: null, total: 1 });
    expect(body.items).toEqual([
      {
        id: batchId,
        deliveryId: expect.stringMatching(UUID),
        source: 'supplier',
        supplierBatchNumber: 'LOT-A',
        product: { id: product.id, name: await nameOf(product.id), deleted: false },
        unitCost: 2.5,
        quantity: 10,
        remaining: 10,
        sold: 0,
        writtenOff: 0,
        value: 25,
        expiresAt: dayOf(90),
        expired: false,
        supplier: 'Acme',
        document: 'INV-7',
        note: 'Morning truck',
        receivedBy: { id: admin.id, role: 'ADMIN' },
        createdAt: expect.any(String),
      },
    ]);
  });

  it('gives null for what a delivery did not name', async () => {
    const product = await newProduct();
    await deliver(
      { source: 'surplus', items: [{ productId: product.id, quantity: 1, unitCost: 0 }] },
      root,
    );

    const [item] = (await batches({ productId: product.id })).json().items;

    expect(item).toMatchObject({
      source: 'surplus',
      supplierBatchNumber: null,
      expiresAt: null,
      expired: false,
      supplier: null,
      document: null,
      note: null,
      value: 0,
      receivedBy: { id: root.id, role: 'ROOT' },
    });
  });

  it('counts the units the paid orders took and the units written off', async () => {
    const product = await newProduct();
    const [batchId] = await deliver({
      source: 'supplier',
      items: [{ productId: product.id, quantity: 10, unitCost: 3 }],
    });
    await placeOrder(app, csrf, await newUser(), product, 'paid', 3);
    await writeOff({ reason: 'damaged', items: [{ productId: product.id, quantity: 2 }] });

    const [item] = (await batches({ productId: product.id })).json().items;

    expect(item).toMatchObject({
      id: batchId,
      quantity: 10,
      remaining: 5,
      sold: 3,
      writtenOff: 2,
      value: 15,
    });
  });

  it('gives the units of a cancelled order back to what is left, not to what was sold', async () => {
    const product = await newProduct();
    await receiveBatch(product.id, { quantity: 4, unitCost: 1 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid', 3);
    await cancelPaid(orderId);

    const [item] = (await batches({ productId: product.id })).json().items;

    expect(item).toMatchObject({ quantity: 4, remaining: 4, sold: 0, writtenOff: 0 });
  });

  it('shows the batch of a product removed from the catalog', async () => {
    const product = await newProduct();
    await receiveBatch(product.id, { quantity: 1 });
    await deleteProductFromCatalog(product.id);

    const [item] = (await batches({ productId: product.id })).json().items;

    expect(item.product).toMatchObject({ id: product.id, deleted: true });
  });

  // the last good day is behind the day of the shop: the units are not sold, they wait for a
  // write-off
  it('tells a batch that is over by the day of the shop', async () => {
    const product = await newProduct();
    const [today] = await deliver({
      source: 'supplier',
      items: [{ productId: product.id, quantity: 2, unitCost: 1, expiresAt: shopToday() }],
    });

    const before = (await batches({ productId: product.id })).json().items[0];
    clock = moveClock(2 * 86_400_000);
    const after = (await batches({ productId: product.id })).json().items[0];

    expect(before).toMatchObject({ id: today, expired: false });
    expect(after).toMatchObject({ id: today, expired: true, remaining: 2 });
  });

  describe('the filters', () => {
    it('keeps the batches of one delivery', async () => {
      const product = await newProduct();
      const other = await newProduct();
      const [first, second] = await deliver({
        source: 'supplier',
        items: [
          { productId: product.id, quantity: 1, unitCost: 1 },
          { productId: other.id, quantity: 1, unitCost: 1 },
        ],
      });
      await receiveBatch(product.id, { quantity: 1 });
      const deliveryId = (await batches({ productId: product.id, sortOrder: 'asc' })).json()
        .items[0].deliveryId;

      const res = await batches({ deliveryId });

      expect(res.statusCode).toBe(200);
      expect(idsOf(res).sort((a, b) => a - b)).toEqual([first, second]);
    });

    it('keeps the batches of a source', async () => {
      const product = await newProduct();
      await receiveBatch(product.id, { quantity: 1, source: 'supplier' });
      const returned = await receiveBatch(product.id, { quantity: 1, source: 'customer_return' });

      const res = await batches({ productId: product.id, source: 'customer_return' });

      expect(idsOf(res)).toEqual([returned]);
    });

    it('keeps the batches with units left, or the empty ones', async () => {
      const product = await newProduct();
      const empty = await receiveBatch(product.id, { quantity: 1, expiresAt: dayOf(5) });
      const left = await receiveBatch(product.id, { quantity: 3 });
      await writeOff({
        reason: 'damaged',
        items: [{ productId: product.id, batchId: empty, quantity: 1 }],
      });

      const withUnits = await batches({ productId: product.id, inStock: true });
      const without = await batches({ productId: product.id, inStock: false });

      expect(idsOf(withUnits)).toEqual([left]);
      expect(idsOf(without)).toEqual([empty]);
    });

    it('keeps the batches that are over, or the ones that are not', async () => {
      const product = await newProduct();
      const today = await receiveBatch(product.id, { quantity: 1, expiresAt: shopToday() });
      const later = await receiveBatch(product.id, { quantity: 1, expiresAt: dayOf(30) });
      const noEnd = await receiveBatch(product.id, { quantity: 1 });
      clock = moveClock(2 * 86_400_000);

      const over = await batches({ productId: product.id, expired: true });
      const notOver = await batches({ productId: product.id, expired: false });

      expect(idsOf(over)).toEqual([today]);
      expect(idsOf(notOver).sort((a, b) => a - b)).toEqual([later, noEnd]);
    });

    it('keeps the batches whose last good day comes by the day asked', async () => {
      const product = await newProduct();
      const soon = await receiveBatch(product.id, { quantity: 1, expiresAt: dayOf(10) });
      const onTheDay = await receiveBatch(product.id, { quantity: 1, expiresAt: dayOf(20) });
      await receiveBatch(product.id, { quantity: 1, expiresAt: dayOf(40) });
      await receiveBatch(product.id, { quantity: 1 });

      const res = await batches({ productId: product.id, expiresBy: dayOf(20) });

      expect(idsOf(res).sort((a, b) => a - b)).toEqual([soon, onTheDay]);
    });

    it('lists nothing for a product without batches', async () => {
      const product = await newProduct();

      const res = await batches({ productId: product.id });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ items: [], nextCursor: null, total: 0 });
    });
  });

  describe('the order', () => {
    it('lists the newest batch first unless asked', async () => {
      const product = await newProduct();
      const first = await receiveBatch(product.id, { quantity: 1 });
      const second = await receiveBatch(product.id, { quantity: 1 });

      expect(idsOf(await batches({ productId: product.id }))).toEqual([second, first]);
      expect(idsOf(await batches({ productId: product.id, sortOrder: 'asc' }))).toEqual([
        first,
        second,
      ]);
    });

    // a batch without an end is never over: it comes after the ones that end, either way
    it('orders by the last good day, the batches without one last', async () => {
      const product = await newProduct();
      const noEnd = await receiveBatch(product.id, { quantity: 1 });
      const late = await receiveBatch(product.id, { quantity: 1, expiresAt: dayOf(40) });
      const soon = await receiveBatch(product.id, { quantity: 1, expiresAt: dayOf(10) });

      const asc = await batches({ productId: product.id, sortBy: 'expiresAt', sortOrder: 'asc' });
      const desc = await batches({ productId: product.id, sortBy: 'expiresAt', sortOrder: 'desc' });

      expect(idsOf(asc)).toEqual([soon, late, noEnd]);
      expect(idsOf(desc)).toEqual([late, soon, noEnd]);
    });

    // the batches: 4 left at 1, 2 left at 3, 1 left at 5
    it.each([
      ['remaining', [0, 1, 2]],
      ['unitCost', [2, 1, 0]],
      // what is left at its cost: 4 * 1, 2 * 3, 1 * 5
      ['value', [1, 2, 0]],
    ] as const)('orders by %s, the largest first', async (sortBy, order) => {
      const product = await newProduct();
      const ids = [
        await receiveBatch(product.id, { quantity: 4, unitCost: 1 }),
        await receiveBatch(product.id, { quantity: 2, unitCost: 3 }),
        await receiveBatch(product.id, { quantity: 1, unitCost: 5 }),
      ];

      const res = await batches({ productId: product.id, sortBy, sortOrder: 'desc' });

      expect(idsOf(res)).toEqual(order.map((index) => ids[index]));
    });

    it.each([
      ['createdAt', 'desc'],
      ['createdAt', 'asc'],
      ['expiresAt', 'asc'],
      ['expiresAt', 'desc'],
      ['remaining', 'asc'],
      ['unitCost', 'desc'],
      ['value', 'asc'],
    ] as const)(
      'gives every batch once over the pages when sorted by %s %s',
      async (sortBy, sortOrder) => {
        const product = await newProduct();
        // equal values and batches without an end fall on the borders of the pages
        const ids = [
          await receiveBatch(product.id, { quantity: 2, unitCost: 1, expiresAt: dayOf(10) }),
          await receiveBatch(product.id, { quantity: 2, unitCost: 1 }),
          await receiveBatch(product.id, { quantity: 1, unitCost: 2, expiresAt: dayOf(10) }),
          await receiveBatch(product.id, { quantity: 3, unitCost: 1 }),
          await receiveBatch(product.id, { quantity: 1, unitCost: 4, expiresAt: dayOf(3) }),
        ];
        const whole = idsOf(await batches({ productId: product.id, sortBy, sortOrder }));

        const paged = await walk(batches, { productId: product.id, sortBy, sortOrder, limit: 2 });

        expect([...whole].sort((a, b) => a - b)).toEqual(ids);
        expect(paged.map((item) => item.id)).toEqual(whole);
      },
    );

    it('refuses the cursor of another order', async () => {
      const product = await newProduct();
      await receiveBatch(product.id, { quantity: 1 });
      await receiveBatch(product.id, { quantity: 1 });
      const { nextCursor } = (await batches({ productId: product.id, limit: 1 })).json();

      const res = await batches({ productId: product.id, sortBy: 'remaining', cursor: nextCursor });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    });

    // a cursor comes back from the client: a value that does not fit the order is no page
    it.each([
      ['a day that is no day', { id: 1, v: '2026-02-30', s: 'expiresAt:asc' }, 'expiresAt', 'asc'],
      ['a count that is text', { id: 1, v: 'many', s: 'remaining:desc' }, 'remaining', 'desc'],
      ['a cost below 0', { id: 1, v: '-1', s: 'unitCost:desc' }, 'unitCost', 'desc'],
      ['a time that is no time', { id: 1, v: 'soon', s: 'createdAt:desc' }, 'createdAt', 'desc'],
      ['no time at all', { id: 1, v: null, s: 'createdAt:desc' }, 'createdAt', 'desc'],
    ] as const)('refuses a cursor with %s', async (_case, payload, sortBy, sortOrder) => {
      const res = await batches({ sortBy, sortOrder, cursor: cursorOf(payload) });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    });
  });

  it.each([
    ['a sort it does not have', { sortBy: 'supplier' }],
    ['a source it does not have', { source: 'gift' }],
    ['a delivery that is not a uuid', { deliveryId: 'abc' }],
    ['a day that is not a day', { expiresBy: '2026-13-01' }],
    ['a product id over the range', { productId: 2147483648 }],
    ['a page of more than 100', { limit: 101 }],
  ])('refuses %s', async (_case, query) => {
    const res = await batches(query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // a guest has the role GUEST, as on the other admin routes
  it('refuses a buyer and a guest', async () => {
    const guest = await app.inject({ method: 'GET', url: '/api/admin/stock/batches' });
    const buyer = await batches({}, await newUser());

    for (const res of [guest, buyer]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    }
  });
});

describe('GET /api/admin/stock/movements', () => {
  // a delivery, a sale of 3 (2 of the batch that ends first, 1 of the other), a write-off of 1
  // and the cancel of the sale
  async function productWithHistory() {
    const product = await newProduct(10);
    const [soon, noEnd] = await deliver({
      source: 'supplier',
      supplier: 'Acme',
      document: 'INV-9',
      note: 'Two lots',
      items: [
        { productId: product.id, quantity: 2, unitCost: 2, expiresAt: dayOf(10) },
        { productId: product.id, quantity: 5, unitCost: 1 },
      ],
    });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid', 3);
    const writeOffId = await writeOff({
      reason: 'shortage',
      note: 'Inventory',
      items: [{ productId: product.id, batchId: noEnd, quantity: 1 }],
    });
    await cancelPaid(orderId);
    return { product, soon: soon!, noEnd: noEnd!, orderId, writeOffId };
  }

  it('puts the deliveries, the sales, the write-offs and the cancels in one list', async () => {
    const { product, soon, noEnd, orderId, writeOffId } = await productWithHistory();
    const name = await nameOf(product.id);

    const res = await movements({ productId: product.id, sortOrder: 'asc' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ currency: 'eur', limit: 20, nextCursor: null, total: 5 });
    const empty = {
      orderId: null,
      deliveryId: null,
      writeOffId: null,
      source: null,
      reason: null,
      supplier: null,
      document: null,
      note: null,
      actor: null,
    };
    const deliveryLine = {
      ...empty,
      kind: 'delivery',
      at: expect.any(String),
      product: { id: product.id, name, deleted: false },
      deliveryId: expect.stringMatching(UUID),
      source: 'supplier',
      supplier: 'Acme',
      document: 'INV-9',
      note: 'Two lots',
      actor: { id: admin.id, role: 'ADMIN' },
    };
    expect(body.items).toEqual([
      // a line of the admin log for each product of a delivery: here two batches, two lines
      {
        ...deliveryLine,
        quantity: 2,
        value: 4,
        batches: [{ batchId: soon, quantity: 2, unitCost: 2 }],
      },
      {
        ...deliveryLine,
        quantity: 5,
        value: 5,
        batches: [{ batchId: noEnd, quantity: 5, unitCost: 1 }],
      },
      {
        ...empty,
        kind: 'sale',
        at: expect.any(String),
        product: { id: product.id, name, deleted: false },
        orderId,
        quantity: -3,
        value: -5,
        batches: [
          { batchId: soon, quantity: 2, unitCost: 2 },
          { batchId: noEnd, quantity: 1, unitCost: 1 },
        ],
      },
      {
        ...empty,
        kind: 'writeOff',
        at: expect.any(String),
        product: { id: product.id, name, deleted: false },
        writeOffId,
        reason: 'shortage',
        note: 'Inventory',
        actor: { id: admin.id, role: 'ADMIN' },
        quantity: -1,
        value: -1,
        batches: [{ batchId: noEnd, quantity: 1, unitCost: 1 }],
      },
      {
        ...empty,
        kind: 'cancel',
        at: expect.any(String),
        product: { id: product.id, name, deleted: false },
        orderId,
        quantity: 3,
        value: 5,
        batches: [
          { batchId: soon, quantity: 2, unitCost: 2 },
          { batchId: noEnd, quantity: 1, unitCost: 1 },
        ],
      },
    ]);
    // the delivery ids of both lines are the one delivery
    expect(body.items[0].deliveryId).toBe(body.items[1].deliveryId);
  });

  it('lists the newest step first unless asked', async () => {
    const { product } = await productWithHistory();

    const res = await movements({ productId: product.id });

    expect(res.json().items.map((item: { kind: string }) => item.kind)).toEqual([
      'cancel',
      'writeOff',
      'sale',
      'delivery',
      'delivery',
    ]);
    const times = res.json().items.map((item: { at: string }) => Date.parse(item.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('keeps only the units of a sale of the product asked for', async () => {
    const product = await newProduct(10);
    const other = await newProduct(10);
    await receiveBatch(product.id, { quantity: 2, unitCost: 1 });
    await receiveBatch(other.id, { quantity: 2, unitCost: 1 });
    const buyer = await newUser();
    await placeOrder(app, csrf, buyer, other, 'cart');
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 2);

    const res = await movements({ productId: product.id, kind: 'sale' });

    expect(res.json().items).toEqual([
      expect.objectContaining({ kind: 'sale', orderId, quantity: -2, value: -2 }),
    ]);
  });

  describe('the filters', () => {
    it('keeps the kinds asked for, one or several through commas', async () => {
      const { product } = await productWithHistory();

      const sales = await movements({ productId: product.id, kind: 'sale' });
      const outs = await movements({
        productId: product.id,
        kind: 'sale,writeOff',
        sortOrder: 'asc',
      });

      expect(sales.json().items.map((item: { kind: string }) => item.kind)).toEqual(['sale']);
      expect(outs.json().items.map((item: { kind: string }) => item.kind)).toEqual([
        'sale',
        'writeOff',
      ]);
    });

    it('keeps the steps of a batch', async () => {
      const { product, noEnd } = await productWithHistory();

      const res = await movements({ batchId: noEnd, sortOrder: 'asc' });

      expect(res.statusCode).toBe(200);
      const items = res.json().items;
      expect(items.map((item: { kind: string }) => item.kind)).toEqual([
        'delivery',
        'sale',
        'writeOff',
        'cancel',
      ]);
      expect(
        items.every((item: { product: { id: number } }) => item.product.id === product.id),
      ).toBe(true);
    });

    it('keeps the steps of an order, of a delivery and of a write-off', async () => {
      const { product, orderId, writeOffId } = await productWithHistory();
      const deliveryId = (await movements({ productId: product.id, kind: 'delivery' })).json()
        .items[0].deliveryId;

      const ofOrder = await movements({ orderId, sortOrder: 'asc' });
      const ofDelivery = await movements({ deliveryId });
      const ofWriteOff = await movements({ writeOffId });

      expect(ofOrder.json().items.map((item: { kind: string }) => item.kind)).toEqual([
        'sale',
        'cancel',
      ]);
      expect(ofDelivery.json().items).toHaveLength(2);
      expect(
        ofDelivery.json().items.every((item: { kind: string }) => item.kind === 'delivery'),
      ).toBe(true);
      expect(ofWriteOff.json().items).toEqual([
        expect.objectContaining({ kind: 'writeOff', writeOffId }),
      ]);
    });

    // the period is [from, to): the steps from the start on, up to the end but not at it
    it('keeps the steps of a period', async () => {
      const { product } = await productWithHistory();
      const all = (await movements({ productId: product.id, sortOrder: 'asc' })).json().items;
      const sale = all.find((item: { kind: string }) => item.kind === 'sale');
      const cancel = all.find((item: { kind: string }) => item.kind === 'cancel');

      const res = await movements({
        productId: product.id,
        from: sale.at,
        to: cancel.at,
        sortOrder: 'asc',
      });

      expect(res.json().items.map((item: { kind: string }) => item.kind)).toEqual([
        'sale',
        'writeOff',
      ]);
    });

    it('refuses a period that ends before it starts', async () => {
      const res = await movements({
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'INVALID_STATS_PERIOD',
        details: { reason: 'FROM_AFTER_TO' },
      });
    });

    // the format of a date lets a leap second through, a date of javascript has none
    it('refuses a leap second as a time it cannot read', async () => {
      const res = await movements({ from: '2016-12-31T23:59:60Z' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'INVALID_STATS_PERIOD',
        details: { field: 'from', reason: 'INVALID_DATE' },
      });
    });

    // a delivery names its id the way a client writes it; the database keeps it in small letters
    it('finds a delivery and a write-off by an id in capital letters', async () => {
      const { product, writeOffId } = await productWithHistory();
      const deliveryId = (await movements({ productId: product.id, kind: 'delivery' })).json()
        .items[0].deliveryId;

      const ofDelivery = await movements({ deliveryId: deliveryId.toUpperCase() });
      const ofWriteOff = await movements({ writeOffId: writeOffId.toUpperCase() });
      const batchesOfDelivery = await batches({ deliveryId: deliveryId.toUpperCase() });

      expect(ofDelivery.json().items).toHaveLength(2);
      expect(ofWriteOff.json().items).toHaveLength(1);
      expect(batchesOfDelivery.json().items).toHaveLength(2);
    });
  });

  it.each([
    ['asc', 'asc'],
    ['desc', 'desc'],
  ] as const)('gives every step once over the pages, %s', async (_case, sortOrder) => {
    const { product } = await productWithHistory();
    const whole = (await movements({ productId: product.id, sortOrder })).json().items;

    const paged = await walk(movements, { productId: product.id, sortOrder, limit: 2 });

    expect(paged).toEqual(whole);
  });

  it('refuses the cursor of another order', async () => {
    const { product } = await productWithHistory();
    const { nextCursor } = (await movements({ productId: product.id, limit: 1 })).json();

    const res = await movements({ productId: product.id, sortOrder: 'asc', cursor: nextCursor });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });

  it.each([
    ['a time that is no time', { id: 1, v: 'soon', k: 0, b: 0, s: 'at:desc' }],
    ['a kind it does not have', { id: 1, v: '2026-01-01T00:00:00.000Z', k: 7, b: 0, s: 'at:desc' }],
    ['a key below 0', { id: 1, v: '2026-01-01T00:00:00.000Z', k: 1, b: -1, s: 'at:desc' }],
    ['a key that is text', { id: 1, v: '2026-01-01T00:00:00.000Z', k: 1, b: '2', s: 'at:desc' }],
  ])('refuses a cursor with %s', async (_case, payload) => {
    const res = await movements({ cursor: cursorOf(payload) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });

  it.each([
    ['a kind it does not have', { kind: 'gift' }],
    ['a write-off that is not a uuid', { writeOffId: 'abc' }],
    ['an order id over the range', { orderId: 2147483648 }],
    ['a date that is not a date', { from: 'yesterday' }],
  ])('refuses %s', async (_case, query) => {
    const res = await movements(query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // a guest has the role GUEST, as on the other admin routes
  it('refuses a buyer and a guest', async () => {
    const guest = await app.inject({ method: 'GET', url: '/api/admin/stock/movements' });
    const buyer = await movements({}, await newUser());

    for (const res of [guest, buyer]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    }
  });
});

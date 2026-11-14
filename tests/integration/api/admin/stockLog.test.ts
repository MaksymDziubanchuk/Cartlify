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
  type TestUser,
} from '../../../helpers/factories.js';
import { placePaidOrderOf } from '../../../helpers/payments.js';

// GET /api/admin/stock-log: the journal of every change of the quantity of a variant, a line for
// each variant for each change. The story below is made through the routes of the shop (two
// deliveries, a write-off, a paid order, its cancel as a statement of return) and the journal is
// read by its filters, sorts, events, columns, period, cursor and csv. Other files write lines at
// the same time: a test narrows the journal to the product of the story

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const AGENT = 'Cartlify stock log test browser';
const ROOT_AGENT = 'Cartlify stock log root browser';

type Story = {
  // the product with two variants, and another product with one
  a1: { id: number; variantId: number };
  a2: { id: number; variantId: number };
  b: { id: number; variantId: number };
  // the first delivery (all three variants, by admin), the write-off (a1 and a2, by root), the
  // paid order (a1 twice and b once), the second delivery (a1 only)
  delivery: string;
  writeOff: string;
  orderId: number;
  secondDelivery: string;
};
let story: Story;

type Line = Record<string, any>;
type Page = { items: Line[]; total: number; limit: number; nextCursor: string | null };

const headersOf = (actor: TestUser, agent = AGENT) => ({
  ...withCsrf(csrf, accessCookie(actor)),
  'user-agent': agent,
});

const post = (url: string, actor: TestUser, payload?: object, agent = AGENT) =>
  app.inject({
    method: 'POST',
    url,
    headers: headersOf(actor, agent),
    ...(payload ? { payload } : {}),
  });

const read = (query: string, actor: TestUser = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/stock-log?${query}`,
    headers: { cookie: accessCookie(actor) },
  });

async function pageOf(query: string, actor: TestUser = admin): Promise<Page> {
  const res = await read(query, actor);
  expect(res.statusCode).toBe(200);
  return res.json() as Page;
}

// every line of a list in one page, or walking it a few lines at a time
const all = (query: string, actor?: TestUser) => pageOf(`${query}&limit=100`, actor);

async function walk(query: string, size: number, actor?: TestUser): Promise<Line[]> {
  const seen: Line[] = [];
  let cursor: string | null = null;
  do {
    const page: Page = await pageOf(
      `${query}&limit=${size}${cursor ? `&cursor=${cursor}` : ''}`,
      actor,
    );
    expect(page.items.length).toBeLessThanOrEqual(size);
    seen.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  return seen;
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
  buyer = await newUser();

  const a1 = await createProduct({ price: 10, stock: 0 });
  const a2 = await createVariant(a1.id, { price: 12, stock: 0 });
  const b = await createProduct({ price: 7, stock: 0 });

  const first = await post('/api/products/stock/deliveries', admin, {
    source: 'supplier',
    supplier: 'Acme',
    document: 'INV-1',
    items: [
      { variantId: a1.variantId, quantity: 5, unitCost: 2 },
      { variantId: a2.id, quantity: 4, unitCost: 3 },
      { variantId: b.variantId, quantity: 6, unitCost: 1.5 },
    ],
  });
  expect(first.statusCode).toBe(201);

  const writeOff = await post(
    '/api/products/stock/write-offs',
    root,
    {
      reason: 'damaged',
      note: 'Wet boxes',
      items: [
        { variantId: a1.variantId, quantity: 1 },
        { variantId: a2.id, quantity: 1 },
      ],
    },
    ROOT_AGENT,
  );
  expect(writeOff.statusCode).toBe(201);

  const { orderId } = await placePaidOrderOf(app, csrf, buyer, [
    { item: { variantId: a1.variantId }, quantity: 2 },
    { item: { variantId: b.variantId }, quantity: 1 },
  ]);
  // the cancel is a statement of return for every unit of the order with the reason shop_cancel
  const orderItems = await asAdmin((tx) =>
    tx.orderItem.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: { id: true, quantity: true },
    }),
  );
  const cancelled = await post('/api/returns', admin, {
    orderId,
    items: orderItems.map((item) => ({ orderItemId: item.id, quantity: item.quantity })),
    basis: 'other',
    reason: 'shop_cancel',
  });
  expect(cancelled.statusCode).toBe(201);

  const second = await post('/api/products/stock/deliveries', admin, {
    source: 'surplus',
    unitCost: 1,
    items: [{ variantId: a1.variantId, quantity: 3 }],
  });
  expect(second.statusCode).toBe(201);

  story = {
    a1: { id: a1.id, variantId: a1.variantId },
    a2: { id: a1.id, variantId: a2.id },
    b: { id: b.id, variantId: b.variantId },
    delivery: first.json().deliveryId,
    writeOff: writeOff.json().writeOffId,
    orderId,
    secondDelivery: second.json().deliveryId,
  };
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// the lines of the product with two variants: 3 deliveries of variants (two of the first delivery,
// one of the second), 2 of the write-off, 1 sale, 1 cancel (the units back)
const mine = () => `productId=${story.a1.id}`;

const SORTS = [
  'id',
  'createdAt',
  'actorId',
  'actorRole',
  'productId',
  'variantId',
  'event',
  'quantityChange',
  'stockAfter',
  'deliveryId',
  'writeOffId',
  'orderId',
  'returnItemId',
  'ip',
  'userAgent',
];

const COLUMNS = [
  'id',
  'createdAt',
  'actorId',
  'actor',
  'actorRole',
  'productId',
  'product',
  'variantId',
  'variant',
  'event',
  'quantityChange',
  'stockAfter',
  'deliveryId',
  'writeOffId',
  'orderId',
  'returnItemId',
  'ip',
  'userAgent',
  'changes',
];

const CSV_HEADER = (columns: string[]) =>
  columns
    .flatMap((column) => {
      if (column === 'actor') return ['actorName', 'actorEmail'];
      if (column === 'product') return ['productName'];
      if (column === 'variant') return ['variantName', 'variantSku'];
      return [column];
    })
    .join(',');

const comparable = (value: unknown) =>
  value === null || value === undefined ? null : typeof value === 'number' ? value : String(value);

// the lines are in the order of the column, the lines without a value last, whichever way it goes
function expectSorted(items: Line[], column: string, order: 'asc' | 'desc') {
  const values = items.map((item) => comparable(item[column]));
  const present = values.filter((value) => value !== null);
  const firstNull = values.indexOf(null);
  if (firstNull >= 0) expect(values.slice(firstNull).every((value) => value === null)).toBe(true);

  const ordered = [...present].sort((x, y) => (x! < y! ? -1 : x! > y! ? 1 : 0));
  if (order === 'desc') ordered.reverse();
  expect(present).toEqual(ordered);
}

describe('GET /api/admin/stock-log', () => {
  it('gives every column of every line of a product, the newest first, with the names of the product and the variant', async () => {
    const page = await all(mine());

    expect(page.total).toBe(7);
    expect(page.items).toHaveLength(7);
    for (const item of page.items) expect(Object.keys(item).sort()).toEqual([...COLUMNS].sort());
    expectSorted(page.items, 'id', 'desc');
    expect(page.items[0]).toMatchObject({
      productId: story.a1.id,
      product: { id: story.a1.id, name: expect.any(String) },
      variant: { id: expect.any(Number), position: expect.any(Number), name: expect.any(String) },
    });
  });

  it('describes a delivery line: the admin, the change, the stock after it, the id of the delivery, the batch and the supplier', async () => {
    const page = await all(`variantId=${story.a1.variantId}&events=stock.delivery&sortOrder=asc`);

    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      actorId: admin.id,
      actor: { id: admin.id, email: admin.email, role: 'ADMIN' },
      actorRole: 'ADMIN',
      productId: story.a1.id,
      variantId: story.a1.variantId,
      event: 'stock.delivery',
      quantityChange: 5,
      stockAfter: 5,
      deliveryId: story.delivery,
      writeOffId: null,
      orderId: null,
      ip: '127.0.0.1',
      userAgent: AGENT,
    });
    expect(page.items[0]!.changes).toEqual([
      {
        field: 'batches',
        old: null,
        new: [{ batchId: expect.any(Number), quantity: 5, unitCost: '2' }],
      },
      { field: 'source', old: null, new: 'supplier' },
      { field: 'supplier', old: null, new: 'Acme' },
      { field: 'document', old: null, new: 'INV-1' },
    ]);
    expect(page.items[1]).toMatchObject({
      quantityChange: 3,
      deliveryId: story.secondDelivery,
    });
  });

  // root reads its own line as it is; what an admin sees of it is in "who reads it"
  it('describes a write-off line: root, the units out, the reason and the batches with their costs', async () => {
    const page = await all(`variantId=${story.a1.variantId}&events=stock.write_off`, root);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      actorId: root.id,
      actorRole: 'ROOT',
      event: 'stock.write_off',
      quantityChange: -1,
      stockAfter: 4,
      deliveryId: null,
      writeOffId: story.writeOff,
      orderId: null,
      userAgent: ROOT_AGENT,
    });
    expect(page.items[0]!.changes).toEqual([
      { field: 'reason', old: null, new: 'damaged' },
      {
        field: 'batches',
        old: null,
        new: [{ batchId: expect.any(Number), quantity: 1, unitCost: '2' }],
      },
      { field: 'note', old: null, new: 'Wet boxes' },
    ]);
  });

  it('describes the sale at the payment: the order, the units out, no account', async () => {
    const page = await all(`variantId=${story.a1.variantId}&events=stock.sale`);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      actorId: null,
      actor: null,
      actorRole: null,
      event: 'stock.sale',
      quantityChange: -2,
      stockAfter: 2,
      deliveryId: null,
      writeOffId: null,
      orderId: story.orderId,
      returnItemId: null,
    });
  });

  it('describes the units back at the cancel: the order, the units in, in the name of the admin who cancelled', async () => {
    const page = await all(`variantId=${story.a1.variantId}&events=stock.return`);
    const [row] = await asAdmin((tx) =>
      tx.orderReturnItem.findMany({
        where: { orderItem: { orderId: story.orderId, variantId: story.a1.variantId } },
        select: { id: true },
      }),
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      actorId: admin.id,
      actorRole: 'ADMIN',
      event: 'stock.return',
      quantityChange: 2,
      stockAfter: 4,
      orderId: story.orderId,
      // the row of the statement the units came back with (6.6)
      returnItemId: row!.id,
      userAgent: AGENT,
    });
    // the same batches with the same costs as the sale took them from
    const sale = (await all(`variantId=${story.a1.variantId}&events=stock.sale`)).items[0]!;
    expect(page.items[0]!.changes).toEqual(sale.changes);
  });

  it('keeps the sum of the changes of a variant equal to its stock, and the last stock after it too', async () => {
    for (const variant of [story.a1.variantId, story.a2.variantId, story.b.variantId]) {
      const lines = (await all(`variantId=${variant}&sortOrder=asc`)).items;
      const stock = await asAdmin((tx) =>
        tx.productVariant.findUniqueOrThrow({ where: { id: variant }, select: { stock: true } }),
      );

      expect(lines.reduce((sum, line) => sum + (line.quantityChange as number), 0)).toBe(
        stock.stock,
      );
      expect(lines.at(-1)!.stockAfter).toBe(stock.stock);
    }
  });

  describe('the filters', () => {
    const idsOf = (page: Page) => page.items.map((item) => item.id).sort();

    it('keeps the lines of a product, all its variants', async () => {
      const page = await all(`productId=${story.a1.id}`);

      expect(new Set(page.items.map((item) => item.variantId))).toEqual(
        new Set([story.a1.variantId, story.a2.variantId]),
      );
      expect(page.total).toBe(7);
    });

    it('keeps the lines of a variant', async () => {
      const page = await all(`variantId=${story.a2.variantId}&sortOrder=asc`);

      expect(page.items.map((item) => [item.event, item.quantityChange, item.stockAfter])).toEqual([
        ['stock.delivery', 4, 4],
        ['stock.write_off', -1, 3],
      ]);
    });

    it('keeps the lines of a delivery, whatever variant of whatever product', async () => {
      const page = await all(`deliveryId=${story.delivery}&sortOrder=asc`);

      expect(page.items.map((item) => item.variantId)).toEqual([
        story.a1.variantId,
        story.a2.variantId,
        story.b.variantId,
      ]);
      expect(page.items.every((item) => item.event === 'stock.delivery')).toBe(true);
      expect(page.total).toBe(3);
    });

    it('keeps the lines of a write-off', async () => {
      const page = await all(`writeOffId=${story.writeOff}`);

      expect(page.items.map((item) => item.variantId).sort()).toEqual(
        [story.a1.variantId, story.a2.variantId].sort(),
      );
      expect(page.items.every((item) => item.event === 'stock.write_off')).toBe(true);
    });

    it('keeps the lines of an order: the sale and the units back, of each of its variants', async () => {
      const page = await all(`orderId=${story.orderId}&sortOrder=asc`);

      expect(page.items.map((item) => [item.variantId, item.event])).toEqual([
        [story.a1.variantId, 'stock.sale'],
        [story.b.variantId, 'stock.sale'],
        [story.a1.variantId, 'stock.return'],
        [story.b.variantId, 'stock.return'],
      ]);
    });

    it('takes the id of an operation in either case of the letters', async () => {
      const page = await all(`deliveryId=${story.delivery.toUpperCase()}`);

      expect(page.total).toBe(3);
    });

    it('combines the filters: all of them have to hold', async () => {
      const deliveryOfProduct = await all(`deliveryId=${story.delivery}&productId=${story.b.id}`);
      const orderOfVariant = await all(`orderId=${story.orderId}&variantId=${story.b.variantId}`);
      const sales = await all(`orderId=${story.orderId}&events=stock.sale`);
      const wrong = await all(`deliveryId=${story.delivery}&orderId=${story.orderId}`);
      const otherProduct = await all(`variantId=${story.a1.variantId}&productId=${story.b.id}`);
      const inPeriod = await all(
        `variantId=${story.a1.variantId}&from=${new Date(Date.now() - 3_600_000).toISOString()}`,
      );

      expect(deliveryOfProduct.items.map((item) => item.variantId)).toEqual([story.b.variantId]);
      expect(orderOfVariant.items.map((item) => item.event).sort()).toEqual([
        'stock.return',
        'stock.sale',
      ]);
      expect(sales.total).toBe(2);
      // no line carries two operations
      expect(wrong.total).toBe(0);
      expect(otherProduct.total).toBe(0);
      expect(inPeriod.total).toBe(5);
    });

    it('tells the lines of one delivery from the lines of another', async () => {
      const first = await all(`deliveryId=${story.delivery}`);
      const second = await all(`deliveryId=${story.secondDelivery}`);

      expect(first.total).toBe(3);
      expect(second.total).toBe(1);
      expect(idsOf(first).filter((id) => idsOf(second).includes(id))).toEqual([]);
    });

    it('finds no line of an operation that is not there', async () => {
      const page = await all('deliveryId=00000000-0000-4000-8000-000000000000');

      expect(page).toMatchObject({ total: 0, items: [], nextCursor: null });
    });
  });

  describe('the validation', () => {
    it.each([
      'productId=0',
      'productId=-1',
      'productId=abc',
      'productId=1.5',
      'productId=2147483648',
      'variantId=0',
      'variantId=-3',
      'variantId=x',
      'variantId=2147483648',
      'orderId=0',
      'orderId=abc',
      'orderId=2147483648',
      'deliveryId=not-a-uuid',
      'deliveryId=123',
      'writeOffId=not-a-uuid',
      'writeOffId=1234',
      'limit=0',
      'limit=101',
      'sortBy=changes',
      'sortBy=actor',
      'sortOrder=sideways',
      'format=xml',
      'from=yesterday',
    ])('refuses the query %s', async (query) => {
      const res = await read(query);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    });

    it('refuses a column or an event the journal has not, and names what it has', async () => {
      const column = await read('columns=id,secret');
      const event = await read('events=stock.delivery,stock.nothing');
      const old = await read('events=legacy.unknown');

      expect(column.statusCode).toBe(400);
      expect(column.json()).toMatchObject({
        errorCode: 'LOG_COLUMNS_INVALID',
        details: { columns: ['secret'], allowed: COLUMNS },
      });
      expect(event.statusCode).toBe(400);
      expect(event.json()).toMatchObject({
        errorCode: 'LOG_EVENTS_INVALID',
        details: {
          events: ['stock.nothing'],
          allowed: [
            'stock.delivery',
            'stock.write_off',
            'stock.sale',
            'stock.return',
            'stock.return_write_off',
          ],
        },
      });
      // the stock log began with its events: no line has the event of an old line
      expect(old.statusCode).toBe(400);
      expect(old.json()).toMatchObject({ errorCode: 'LOG_EVENTS_INVALID' });
    });

    it('refuses a period that ends before it starts', async () => {
      const res = await read('from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z');

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'INVALID_STATS_PERIOD' });
    });

    it('refuses a cursor made for another sort', async () => {
      const first = await pageOf(`${mine()}&limit=1&sortBy=event`);

      const res = await read(`${mine()}&limit=1&sortBy=id&cursor=${first.nextCursor}`);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    });
  });

  describe('the sorts', () => {
    // root reads the values as they are, so the order of the values can be checked; an admin gets
    // the same lines in the same order, with the data of root hidden (see "who reads it")
    // one test a column: every column walks its pages both ways for root and for an admin
    it.each(SORTS)(
      'sorts by %s both ways, and the cursor walks the lines in the same order',
      async (sortBy) => {
        for (const sortOrder of ['asc', 'desc'] as const) {
          const query = `${mine()}&sortBy=${sortBy}&sortOrder=${sortOrder}`;

          const whole = await all(query, root);
          const walked = await walk(query, 3, root);
          const walkedByAdmin = await walk(query, 3);

          expect(whole.items).toHaveLength(7);
          expectSorted(whole.items, sortBy, sortOrder);
          // the same lines in the same order, page by page, none twice and none missed
          expect(walked.map((item) => item.id)).toEqual(whole.items.map((item) => item.id));
          expect(walkedByAdmin.map((item) => item.id)).toEqual(whole.items.map((item) => item.id));
        }
      },
    );

    it('puts the lines without a value last whichever way the column goes', async () => {
      for (const sortOrder of ['asc', 'desc'] as const) {
        const page = await all(`orderId=${story.orderId}&sortBy=deliveryId&sortOrder=${sortOrder}`);

        // none of the lines of an order has a delivery: the id breaks the tie in the same direction
        const ids = page.items.map((item) => item.id as number);
        expect(ids).toEqual([...ids].sort((x, y) => (sortOrder === 'asc' ? x - y : y - x)));
      }
    });

    it('walks the lines one at a time, none twice and none missed', async () => {
      const whole = await all(mine());
      const walked = await walk(mine(), 1);

      expect(walked).toHaveLength(7);
      expect(new Set(walked.map((item) => item.id)).size).toBe(7);
      expect(walked.map((item) => item.id)).toEqual(whole.items.map((item) => item.id));
    });

    it('sorts by the change: the units out first, the largest in last', async () => {
      const page = await all(`${mine()}&sortBy=quantityChange&sortOrder=asc`);

      expect(page.items.map((item) => item.quantityChange)).toEqual([-2, -1, -1, 2, 3, 4, 5]);
    });
  });

  describe('the events, the columns and the period', () => {
    it('keeps the lines of the events asked for and counts only them', async () => {
      const some = await all(`${mine()}&events=stock.sale,stock.return`);
      const one = await all(`${mine()}&events=stock.write_off`);

      expect(some.total).toBe(2);
      expect(some.items.map((item) => item.event).sort()).toEqual(['stock.return', 'stock.sale']);
      expect(one.total).toBe(2);
    });

    it('gives the columns asked for, in the page and in the csv', async () => {
      const page = await all(`${mine()}&columns=stockAfter,event,id`);
      const csv = await read(`${mine()}&columns=stockAfter,event,id&format=csv`);

      for (const item of page.items) {
        expect(Object.keys(item).sort()).toEqual(['event', 'id', 'stockAfter']);
      }
      const lines = csv.body
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      // the order of the journal, not the order of the request
      expect(lines[0]).toBe('id,event,stockAfter');
      expect(lines).toHaveLength(8);
    });

    it('reads a period: from taken in, to left out', async () => {
      const now = Date.now();
      const day = 86_400_000;

      const inside = await all(
        `${mine()}&from=${new Date(now - 2 * day).toISOString()}&to=${new Date(now + day).toISOString()}`,
      );
      const before = await all(`${mine()}&to=${new Date(now - 2 * day).toISOString()}`);
      const after = await all(`${mine()}&from=${new Date(now + 2 * day).toISOString()}`);
      // a period that starts at the time of a line takes it in and ends where it is left out
      const at = (await all(`${mine()}&sortOrder=asc`)).items[0]!.createdAt as string;
      const tokenFrom = await all(`${mine()}&from=${at}`);
      const tokenTo = await all(`${mine()}&to=${at}`);

      expect(inside.total).toBe(7);
      expect(before.total).toBe(0);
      expect(after.total).toBe(0);
      expect(tokenFrom.total).toBe(7);
      expect(tokenTo.total).toBe(0);
    });
  });

  describe('the csv', () => {
    it('gives every line of the filters with the header of all the columns', async () => {
      const csv = await read(`${mine()}&format=csv&sortBy=event`);

      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toContain('cartlify-stock-log-');
      const lines = csv.body
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      expect(lines[0]).toBe(CSV_HEADER(COLUMNS));
      expect(lines).toHaveLength(8);
      // no page: every line comes, whatever the limit
      const limited = await read(`${mine()}&format=csv&limit=2`);
      expect(limited.body.trim().split('\r\n')).toHaveLength(8);
    });

    it('writes the delivery, the order and the numbers of a line', async () => {
      const csv = await read(
        `orderId=${story.orderId}&events=stock.sale&variantId=${story.a1.variantId}&format=csv&columns=quantityChange,stockAfter,orderId,deliveryId,actorRole`,
      );

      const lines = csv.body
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      expect(lines).toEqual([
        'actorRole,quantityChange,stockAfter,deliveryId,orderId',
        `,-2,2,,${story.orderId}`,
      ]);
    });
  });

  describe('who reads it', () => {
    it('lets root read the same lines as an admin, the same filters', async () => {
      const seenByAdmin = await all(mine());
      const seenByRoot = await all(mine(), root);

      expect(seenByRoot.total).toBe(seenByAdmin.total);
      expect(seenByRoot.items.map((item) => item.id)).toEqual(
        seenByAdmin.items.map((item) => item.id),
      );
    });

    it('refuses a customer', async () => {
      const res = await read(mine(), buyer);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    });

    it('refuses a visitor who is not signed in', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/admin/stock-log?${mine()}` });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    });

    it('hides who root is from an admin and shows it to root, the lines and the filters the same', async () => {
      const query = `writeOffId=${story.writeOff}`;

      const seenByAdmin = (await all(query)).items[0]!;
      const seenByRoot = (await all(query, root)).items[0]!;

      expect(seenByAdmin).toMatchObject({
        actorId: 0,
        actor: { id: 0, email: 'hidden', role: 'ROOT' },
        // the role stays: it is no secret who did it as root, only who root is
        actorRole: 'ROOT',
        ip: 'hidden',
        userAgent: 'hidden',
        event: 'stock.write_off',
      });
      expect([null, 'hidden']).toContain(seenByAdmin.actor.name);
      expect(seenByRoot).toMatchObject({
        actorId: root.id,
        actor: { id: root.id, email: root.email, role: 'ROOT' },
        ip: '127.0.0.1',
        userAgent: ROOT_AGENT,
      });
      // the same fields for both: only the values differ
      expect(Object.keys(seenByAdmin).sort()).toEqual(Object.keys(seenByRoot).sort());
      // an admin finds the lines of root by the account too, the filter is no secret
      const sorted = await all(`${query}&sortBy=actorId&sortOrder=asc`);
      expect(sorted.total).toBe(2);
    });

    it('does not carry the value of a line of root in the cursor an admin is given', async () => {
      for (const sortBy of ['ip', 'userAgent', 'actorId']) {
        const page = await pageOf(`${mine()}&sortBy=${sortBy}&sortOrder=desc&limit=1`);

        const decoded = Buffer.from(page.nextCursor!, 'base64url').toString('utf8');
        expect(decoded).not.toContain(ROOT_AGENT);
        expect(decoded).not.toContain('127.0.0.1');
      }
    });
  });
});

// the batches, the movements and the accounting read the stock log: the data of the story was made
// through the routes, so what they read is what the routes wrote
describe('what reads the stock log', () => {
  const get = (url: string, actor: TestUser = admin) =>
    app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

  it('gives the batches of a delivery the supplier, the invoice and the admin of its line', async () => {
    const res = await get(`/api/admin/stock/batches?deliveryId=${story.delivery}&sortOrder=asc`);

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(3);
    for (const batch of res.json().items) {
      expect(batch).toMatchObject({
        deliveryId: story.delivery,
        supplier: 'Acme',
        document: 'INV-1',
        note: null,
        receivedBy: { id: admin.id, role: 'ADMIN' },
      });
    }
    // the second delivery has none of those, and its own admin
    const second = await get(`/api/admin/stock/batches?deliveryId=${story.secondDelivery}`);
    expect(second.json().items).toEqual([
      expect.objectContaining({
        supplier: null,
        document: null,
        receivedBy: { id: admin.id, role: 'ADMIN' },
      }),
    ]);
  });

  it('lists every step of the stock of the product: deliveries, write-offs, the sale and the return of the cancel', async () => {
    const res = await get(
      `/api/admin/stock/movements?productId=${story.a1.id}&sortOrder=asc&limit=100`,
    );

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, any>>;
    expect(items.map((item) => [item.kind, item.variant.id, item.quantity, item.value])).toEqual([
      ['delivery', story.a1.variantId, 5, 10],
      ['delivery', story.a2.variantId, 4, 12],
      ['writeOff', story.a1.variantId, -1, -2],
      ['writeOff', story.a2.variantId, -1, -3],
      ['sale', story.a1.variantId, -2, -4],
      ['return', story.a1.variantId, 2, 4],
      ['delivery', story.a1.variantId, 3, 3],
    ]);
    expect(items[0]).toMatchObject({
      deliveryId: story.delivery,
      source: 'supplier',
      supplier: 'Acme',
      document: 'INV-1',
      actor: { id: admin.id, role: 'ADMIN' },
    });
    expect(items[2]).toMatchObject({
      writeOffId: story.writeOff,
      reason: 'damaged',
      note: 'Wet boxes',
      actor: { id: root.id, role: 'ROOT' },
    });
    // the sale is the work of the system and has no account; the units back are taken in by the
    // admin who cancelled the order
    expect(items[4]).toMatchObject({ orderId: story.orderId, actor: null });
    expect(items[5]).toMatchObject({
      orderId: story.orderId,
      actor: { id: admin.id, role: 'ADMIN' },
    });
    // the filters of the journal find the same lines by the ids of the operations
    const byOrder = await get(`/api/admin/stock/movements?orderId=${story.orderId}&limit=100`);
    const byDelivery = await get(
      `/api/admin/stock/movements?deliveryId=${story.delivery}&limit=100`,
    );
    const byWriteOff = await get(
      `/api/admin/stock/movements?writeOffId=${story.writeOff}&limit=100`,
    );
    expect(byOrder.json().total).toBe(4);
    expect(byDelivery.json().total).toBe(3);
    expect(byWriteOff.json().total).toBe(2);
  });

  it('counts the write-off in the accounting report at the costs of its batches', async () => {
    const query = new URLSearchParams({
      from: new Date(Date.now() - 3_600_000).toISOString(),
      to: new Date(Date.now() + 3_600_000).toISOString(),
      productIds: String(story.a1.id),
    });

    const res = await get(`/api/admin/reports/accounting?${query}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().writeOffs).toMatchObject({
      units: 2,
      value: 5,
      byReason: { damaged: { units: 2, value: 5 } },
    });
  });

  it('counts the write-off in the step of the timeline it was made in', async () => {
    const query = new URLSearchParams({
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 86_400_000).toISOString(),
      step: 'day',
      productIds: String(story.a1.id),
    });

    const res = await get(`/api/admin/reports/accounting/timeline?${query}`);

    expect(res.statusCode).toBe(200);
    const written = (res.json().items as Array<{ writeOffs: { units: number; value: number } }>)
      .map((step) => step.writeOffs)
      .reduce((sum, one) => ({ units: sum.units + one.units, value: sum.value + one.value }), {
        units: 0,
        value: 0,
      });
    expect(written).toEqual({ units: 2, value: 5 });
  });
});

// one filter for every other column, the sum of the changes of the filters, the groups (the
// journals for the analysis)
describe('GET /api/admin/stock-log by every column', () => {
  const idsOf = (lines: Line[]) => lines.map((line) => line.id as number).sort((a, b) => a - b);
  const storyLines = async () => (await all(mine(), root)).items;
  const keptBy = async (filter: string, actor: TestUser = root) =>
    idsOf((await all(`${mine()}&${filter}`, actor)).items);

  it.each<[string, (line: Line) => boolean]>([
    ['quantityFrom=1', (line) => line.quantityChange >= 1],
    ['quantityTo=-1', (line) => line.quantityChange <= -1],
    ['quantityFrom=2&quantityTo=4', (line) => line.quantityChange >= 2 && line.quantityChange <= 4],
    ['stockAfterFrom=4', (line) => line.stockAfter >= 4],
    ['stockAfterTo=3', (line) => line.stockAfter <= 3],
    ['actorRole=ROOT', (line) => line.actorRole === 'ROOT'],
    ['actorRole=ADMIN', (line) => line.actorRole === 'ADMIN'],
    [
      'userAgent=ROOT%20BROWSER',
      (line) =>
        String(line.userAgent ?? '')
          .toLowerCase()
          .includes('root browser'),
    ],
  ])('keeps the lines of %s and every one of them', async (filter, keeps) => {
    const expected = idsOf((await storyLines()).filter(keeps));

    expect(expected.length).toBeGreaterThan(0);
    expect(await keptBy(filter)).toEqual(expected);
  });

  it('keeps the lines of who did it, of a statement and of its rows, of a category', async () => {
    const lines = await storyLines();
    const back = lines.filter((line) => line.returnItemId !== null);
    const [{ categoryId }] = await asAdmin((tx) =>
      tx.product.findMany({ where: { id: story.a1.id }, select: { categoryId: true } }),
    );
    const returnId = (
      await asAdmin((tx) =>
        tx.orderReturnItem.findUniqueOrThrow({
          where: { id: back[0]!.returnItemId },
          select: { returnId: true },
        }),
      )
    ).returnId;

    expect(await keptBy(`actorId=${root.id}`)).toEqual(
      idsOf(lines.filter((line) => line.actorId === root.id)),
    );
    expect(await keptBy(`returnItemId=${back[0]!.returnItemId}`)).toEqual(
      idsOf(back.filter((line) => line.returnItemId === back[0]!.returnItemId)),
    );
    expect(await keptBy(`returnId=${returnId}`)).toEqual(idsOf(back));
    expect(await keptBy(`categoryId=${categoryId}`)).toEqual(idsOf(lines));
  });

  // an admin sees the lines of root in the lists and the sorts, but cannot pick them out by who did
  // them
  it('lets an admin pick none of the lines of root by who did them', async () => {
    const ofRoot = idsOf((await storyLines()).filter((line) => line.actorId === root.id));
    expect(ofRoot.length).toBeGreaterThan(0);

    expect(await keptBy(`actorId=${root.id}`, admin)).toEqual([]);
    expect(await keptBy('actorRole=ROOT', admin)).toEqual([]);
    expect(await keptBy(`actorId=${root.id}`)).toEqual(ofRoot);
  });

  it('never finds the lines of root by its browser for an admin', async () => {
    expect(await keptBy('userAgent=root%20browser', admin)).toEqual([]);
    expect((await keptBy('userAgent=root%20browser', root)).length).toBeGreaterThan(0);
  });

  it('gives the sum of the changes of every line of the filters, whatever the page', async () => {
    const lines = (await all(mine())).items;
    const page = (await pageOf(`${mine()}&limit=1`)) as Page & { sums: unknown };

    expect(page.items).toHaveLength(1);
    expect(page.sums).toEqual({
      quantityChange: lines.reduce((sum, line) => sum + (line.quantityChange as number), 0),
    });
  });

  it.each([
    'quantityFrom=abc',
    'stockAfterTo=100000000',
    'actorRole=GUEST',
    'actorId=0',
    'returnId=0',
    'categoryId=x',
    'ip=',
  ])('refuses the query %s', async (query) => {
    const res = await read(query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('GET /api/admin/stock-log/groups', () => {
  type Group = Record<string, any> & { count: number; quantityChange: number };
  type Groups = { items: Group[]; total: number; limit: number; offset: number };
  const groups = (query: string, actor: TestUser = admin) =>
    app.inject({
      method: 'GET',
      url: `/api/admin/stock-log/groups?${query}`,
      headers: { cookie: accessCookie(actor) },
    });
  const groupsOf = async (query: string, actor: TestUser = admin) => {
    const res = await groups(query, actor);
    expect(res.statusCode).toBe(200);
    return res.json() as Groups;
  };

  it('takes the lines of the filters together by the variant and the event, with their count and the sum of the changes', async () => {
    const lines = (await all(mine())).items;
    const expected = new Map<
      string,
      { variantId: number; event: string; count: number; sum: number }
    >();
    for (const line of lines) {
      const key = `${line.variantId}|${line.event}`;
      const group = expected.get(key) ?? {
        variantId: line.variantId as number,
        event: line.event as string,
        count: 0,
        sum: 0,
      };
      group.count += 1;
      group.sum += line.quantityChange as number;
      expected.set(key, group);
    }

    const out = await groupsOf(
      `${mine()}&groupBy=variantId,event&sortBy=quantityChange&sortOrder=asc&limit=100`,
    );

    expect(out.total).toBe(expected.size);
    expect(out.items.map((group) => group.quantityChange)).toEqual(
      [...out.items.map((group) => group.quantityChange)].sort((a, b) => a - b),
    );
    expect(
      out.items
        .map((group) => ({
          variantId: group.variantId,
          event: group.event,
          count: group.count,
          sum: group.quantityChange,
        }))
        .sort((a, b) => `${a.variantId}|${a.event}`.localeCompare(`${b.variantId}|${b.event}`)),
    ).toEqual(
      [...expected.values()].sort((a, b) =>
        `${a.variantId}|${a.event}`.localeCompare(`${b.variantId}|${b.event}`),
      ),
    );
  });

  it('keeps root one group of the hidden id for an admin, and itself for root', async () => {
    const forAdmin = await groupsOf(`${mine()}&groupBy=actorId`);
    const forRoot = await groupsOf(`${mine()}&groupBy=actorId`, root);

    expect(forAdmin.items.map((group) => group.actorId)).toContain(0);
    expect(forAdmin.items.map((group) => group.actorId)).not.toContain(root.id);
    expect(forRoot.items.map((group) => group.actorId)).toContain(root.id);
  });

  it('gives every group as a csv file', async () => {
    const res = await groups(`${mine()}&groupBy=day&format=csv`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.split('\r\n')[0]).toBe('﻿day,count,quantityChange');
  });

  it.each(['', 'groupBy=amount', 'groupBy=event,day,week,month', 'groupBy=event&sortBy=amount'])(
    'refuses the query %s',
    async (query) => {
      const res = await groups(query);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    },
  );

  // the sorts of the groups are their own: the count and a key of time are no sorts of the journal
  it('sorts the groups by their count and by a key they group by', async () => {
    const byCount = await groupsOf(`${mine()}&groupBy=event&sortBy=count&sortOrder=asc`);
    const byDay = await groupsOf(`${mine()}&groupBy=day,event&sortBy=day&sortOrder=asc`);

    const counts = byCount.items.map((group) => group.count);
    expect(counts.length).toBeGreaterThan(1);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    const days = byDay.items.map((group) => group.day as string);
    expect(days).toEqual([...days].sort());
  });

  it('refuses a sort by a key it does not group by, and a customer', async () => {
    const sort = await groups('groupBy=event&sortBy=day');
    const customer = await groups('groupBy=event', buyer);

    expect(sort.statusCode).toBe(400);
    expect(sort.json()).toMatchObject({ errorCode: 'LOG_SORT_INVALID' });
    expect(customer.statusCode).toBe(403);
  });
});

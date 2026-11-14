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
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';
import { refundReturn } from '../../../helpers/returns.js';

// GET /api/orders by the status of the statements of return: the filter returnStatuses (names
// separated by commas) and the sort returnStatus, which goes in the order of the names of the enum
// (none, open, open_partial, partial, full, declined) and pages with a cursor. The buyer reads the
// same on their own orders. The orders of other files share the database, so every request is
// narrowed to the buyer of this file (an admin names userId, the buyer sees only their own orders)

// the order the database sorts the names in: the order they are declared in
const STATUSES = ['none', 'open', 'open_partial', 'partial', 'full', 'declined'] as const;
type Status = (typeof STATUSES)[number];

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
let product: TestProduct;
const userIds: number[] = [];

// the orders of the buyer and the status each must have by the rules of the statements
const orders: Array<{ id: number; status: Status }> = [];
const idsOf = (status: Status) =>
  orders.filter((order) => order.status === status).map((order) => order.id);
const allIds = () => orders.map((order) => order.id);

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const post = (url: string, payload: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

type Placed = { orderId: number; itemId: number };

async function sentOrder(quantity: number): Promise<Placed> {
  const orderId = await placeOrder(app, csrf, buyer, product, 'shipped', quantity);
  const item = await asAdmin((tx) =>
    tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } }),
  );
  return { orderId, itemId: item.id };
}

// the statement of an admin for units of the item; the card
async function state(placed: Placed, quantity: number) {
  const res = await post('/api/returns', {
    orderId: placed.orderId,
    items: [{ orderItemId: placed.itemId, quantity }],
    basis: 'other',
    reason: 'defect',
  });
  if (res.statusCode !== 201) throw new Error(`the statement answered ${res.statusCode}`);
  return res.json() as { id: number; items: Array<{ id: number }> };
}

// the units of the statement are on the shelf again and their money goes back: the statement closes
async function takeBackAndRefund(
  card: { id: number; items: Array<{ id: number }> },
  units: number,
) {
  const received = await post(`/api/returns/${card.id}/receive`, {
    parcel: { buyerPaid: 0 },
    results: [{ itemId: card.items[0]!.id, quantity: units, goods: 'to_stock' }],
  });
  if (received.statusCode !== 200) throw new Error(`the goods answered ${received.statusCode}`);
  await refundReturn(admin.id, card.id);
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  buyer = await newUser({ name: 'Anna Koval' });
  product = await createProduct({ price: 10, stock: 100 });

  const add = (id: number, status: Status) => orders.push({ id, status });

  // none: no statement
  add((await sentOrder(1)).orderId, 'none');
  add((await sentOrder(2)).orderId, 'none');

  // open: a statement waits for its goods and nothing went back
  for (let i = 0; i < 2; i += 1) {
    const placed = await sentOrder(1);
    await state(placed, 1);
    add(placed.orderId, 'open');
  }

  // open_partial: one unit came back with its money, the statement of the other one is open
  let placed = await sentOrder(2);
  await takeBackAndRefund(await state(placed, 1), 1);
  await state(placed, 1);
  add(placed.orderId, 'open_partial');

  // partial: one unit of two came back with its money, nothing is open
  placed = await sentOrder(2);
  await takeBackAndRefund(await state(placed, 1), 1);
  add(placed.orderId, 'partial');

  // full: every unit came back with its money
  placed = await sentOrder(1);
  await takeBackAndRefund(await state(placed, 1), 1);
  add(placed.orderId, 'full');

  // declined: the shop did not accept the goods, so no money went back
  placed = await sentOrder(1);
  const card = await state(placed, 1);
  const refused = await post(`/api/returns/${card.id}/receive`, {
    parcel: { buyerPaid: 0 },
    results: [
      { itemId: card.items[0]!.id, quantity: 1, goods: 'not_accepted', notAcceptedReason: 'used' },
    ],
  });
  if (refused.statusCode !== 200) throw new Error(`the refusal answered ${refused.statusCode}`);
  add(placed.orderId, 'declined');
}, 120_000);

afterAll(async () => {
  await closeSessions(userIds);
  await stopApp();
});

type Listed = { id: number; returnStatus: string };
type Page = { items: Listed[]; total: number; limit: number; nextCursor?: string | null };

const listAs = (actor: TestUser, query: Record<string, string | number>) =>
  app.inject({
    method: 'GET',
    url: `/api/orders?${new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    )}`,
    headers: { cookie: accessCookie(actor) },
  });

// the admin names the buyer; the buyer is narrowed by the route itself
const adminList = (query: Record<string, string | number> = {}) =>
  listAs(admin, { userId: buyer.id, limit: 100, ...query });
const buyerList = (query: Record<string, string | number> = {}) =>
  listAs(buyer, { limit: 100, ...query });

const sortedIds = (res: { json: () => Page }) =>
  res
    .json()
    .items.map((order) => order.id)
    .sort((a, b) => a - b);
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe('what each order of the data has by the rules of the statements', () => {
  it('says its returnStatus in the list, for the admin and for the buyer', async () => {
    const byAdmin = await adminList();
    const byBuyer = await buyerList();

    for (const res of [byAdmin, byBuyer]) {
      expect(res.statusCode).toBe(200);
      const found = new Map(
        res.json().items.map((order: Listed) => [order.id, order.returnStatus]),
      );
      for (const order of orders) expect(found.get(order.id)).toBe(order.status);
      expect(res.json().total).toBe(orders.length);
    }
  });
});

describe('GET /api/orders?returnStatuses=', () => {
  it.each(STATUSES)('lists the orders of the status %s', async (status) => {
    const byAdmin = await adminList({ returnStatuses: status });
    const byBuyer = await buyerList({ returnStatuses: status });

    expect(byAdmin.statusCode).toBe(200);
    expect(sortedIds(byAdmin)).toEqual(sorted(idsOf(status)));
    expect(byAdmin.json().total).toBe(idsOf(status).length);
    // the buyer reads the same of their own orders
    expect(sortedIds(byBuyer)).toEqual(sorted(idsOf(status)));
    expect(byBuyer.json().total).toBe(idsOf(status).length);
    for (const order of byAdmin.json().items) expect(order.returnStatus).toBe(status);
  });

  it('lists the orders of any of the statuses named, and counts one named twice once', async () => {
    const two = await adminList({ returnStatuses: 'open,open_partial' });
    const twice = await adminList({ returnStatuses: 'partial,partial' });
    const three = await adminList({ returnStatuses: 'full,declined,none' });

    expect(sortedIds(two)).toEqual(sorted([...idsOf('open'), ...idsOf('open_partial')]));
    expect(sortedIds(twice)).toEqual(sorted(idsOf('partial')));
    expect(sortedIds(three)).toEqual(
      sorted([...idsOf('full'), ...idsOf('declined'), ...idsOf('none')]),
    );
    expect(three.json().total).toBe(4);
  });

  it('lists every order when all the statuses are named', async () => {
    const res = await adminList({ returnStatuses: STATUSES.join(',') });

    expect(sortedIds(res)).toEqual(sorted(allIds()));
  });

  it('meets the other filters too', async () => {
    // a shipped order whose every unit came back is cancelled: the status of the order and the
    // status of its statements are two filters that both hold
    const cancelledFull = await adminList({ statuses: 'cancelled', returnStatuses: 'full' });
    const shippedFull = await adminList({ statuses: 'shipped', returnStatuses: 'full' });
    const shippedOpen = await adminList({ statuses: 'shipped', returnStatuses: 'open' });
    const paidOpen = await adminList({ statuses: 'paid', returnStatuses: 'open' });

    expect(sortedIds(cancelledFull)).toEqual(sorted(idsOf('full')));
    expect(sortedIds(shippedFull)).toEqual([]);
    expect(sortedIds(shippedOpen)).toEqual(sorted(idsOf('open')));
    expect(sortedIds(paidOpen)).toEqual([]);
  });

  it('keeps the orders of other buyers out of the list of the buyer', async () => {
    const other = await newUser({ name: 'Other Buyer' });

    const res = await listAs(other, { returnStatuses: STATUSES.join(',') });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it.each([
    ['a status there is not', 'foo'],
    ['one status there is not among good ones', 'open,foo'],
    ['a name in capitals', 'OPEN'],
    ['a comma with nothing after it', 'open,'],
    ['a space around the comma', 'open, full'],
    ['nothing at all', ''],
  ])('refuses %s', async (_what, returnStatuses) => {
    const res = await adminList({ returnStatuses });

    expect(res.statusCode).toBe(400);
    // the pattern of the schema refuses a status there is not before the service looks at it
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('GET /api/orders?sortBy=returnStatus', () => {
  // the order of the rule: the position of the status in the list of the names, then the id, both
  // in the direction asked
  const expectedIds = (sortDir: 'asc' | 'desc') =>
    [...orders]
      .sort((a, b) => {
        const byStatus = STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status);
        const order = byStatus !== 0 ? byStatus : a.id - b.id;
        return sortDir === 'asc' ? order : -order;
      })
      .map((order) => order.id);

  it.each(['asc', 'desc'] as const)(
    'sorts the orders %s in the order of the names and pages through the cursor without a repeat or a gap',
    async (sortDir) => {
      const whole = await adminList({ sortBy: 'returnStatus', sortDir });
      const seen: number[] = [];
      const sizes: number[] = [];
      let cursor: string | null | undefined;
      for (let turn = 0; turn < 10; turn += 1) {
        const page: { json: () => Page; statusCode: number } = await adminList({
          sortBy: 'returnStatus',
          sortDir,
          limit: 3,
          ...(cursor ? { cursor } : {}),
        });
        expect(page.statusCode).toBe(200);
        expect(page.json().total).toBe(orders.length);
        sizes.push(page.json().items.length);
        seen.push(...page.json().items.map((order) => order.id));
        cursor = page.json().nextCursor;
        if (!cursor) break;
      }

      expect(whole.json().items.map((order: Listed) => order.id)).toEqual(expectedIds(sortDir));
      expect(sizes).toEqual([3, 3, 2]);
      expect(seen).toEqual(expectedIds(sortDir));
      expect(new Set(seen).size).toBe(orders.length);
    },
  );

  it('sorts the statuses none first and declined last when ascending, and the other way round when descending', async () => {
    const asc = await adminList({ sortBy: 'returnStatus', sortDir: 'asc' });
    const desc = await adminList({ sortBy: 'returnStatus', sortDir: 'desc' });

    const ascNames = asc.json().items.map((order: Listed) => order.returnStatus);
    const descNames = desc.json().items.map((order: Listed) => order.returnStatus);
    expect(ascNames).toEqual([
      'none',
      'none',
      'open',
      'open',
      'open_partial',
      'partial',
      'full',
      'declined',
    ]);
    expect(descNames).toEqual([...ascNames].reverse());
  });

  it('pages a sorted and filtered list: the cursor keeps the filter', async () => {
    const first = await adminList({
      sortBy: 'returnStatus',
      sortDir: 'asc',
      returnStatuses: 'none,open,declined',
      limit: 2,
    });
    const second = await adminList({
      sortBy: 'returnStatus',
      sortDir: 'asc',
      returnStatuses: 'none,open,declined',
      limit: 2,
      cursor: first.json().nextCursor,
    });
    const third = await adminList({
      sortBy: 'returnStatus',
      sortDir: 'asc',
      returnStatuses: 'none,open,declined',
      limit: 2,
      cursor: second.json().nextCursor,
    });

    // none, none | open, open | declined
    const seen = [first, second, third].flatMap((page) =>
      page.json().items.map((order: Listed) => order.id),
    );
    expect(seen).toEqual([...idsOf('none'), ...idsOf('open'), ...idsOf('declined')]);
    expect(third.json().nextCursor ?? null).toBeNull();
    expect(first.json().total).toBe(5);
  });

  it('sorts the orders of the buyer for the buyer too', async () => {
    const res = await buyerList({ sortBy: 'returnStatus', sortDir: 'desc' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((order: Listed) => order.id)).toEqual(expectedIds('desc'));
  });

  it('refuses a cursor of another sort or of another direction (400 CURSOR_INVALID)', async () => {
    const byDate = await adminList({ sortBy: 'createdAt', limit: 2 });
    const byStatus = await adminList({ sortBy: 'returnStatus', sortDir: 'asc', limit: 2 });

    const dateCursorForStatus = await adminList({
      sortBy: 'returnStatus',
      sortDir: 'asc',
      cursor: byDate.json().nextCursor,
    });
    const statusCursorForDate = await adminList({
      sortBy: 'createdAt',
      cursor: byStatus.json().nextCursor,
    });
    const otherDirection = await adminList({
      sortBy: 'returnStatus',
      sortDir: 'desc',
      cursor: byStatus.json().nextCursor,
    });

    for (const res of [dateCursorForStatus, statusCursorForDate, otherDirection]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    }
  });

  it('refuses a cursor that names a status there is not (400 CURSOR_INVALID)', async () => {
    const made = Buffer.from(
      JSON.stringify({ id: 1, v: 'sideways', s: 'returnStatus:asc' }),
    ).toString('base64url');

    const res = await adminList({ sortBy: 'returnStatus', sortDir: 'asc', cursor: made });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });
});

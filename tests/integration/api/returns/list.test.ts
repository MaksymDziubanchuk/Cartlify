import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { encodeCursor } from '@helpers/codeCursor.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  removeProducts,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import type { Buyable } from '../../../helpers/orders.js';
import { moveClock } from '../../../helpers/payments.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import { beginReturnRefund, failReturnRefund, refundReturn } from '../../../helpers/returns.js';

// the list of the statements of withdrawal and of return, GET /api/returns, for an admin or root:
// each line with the units and the money of its rows, the filters (the state, what became of the
// goods and of the money, where it came from, the order, the buyer, the product, a text, the
// periods and the days the alerts use), the sorts with the cursor, the total of the filter and the
// csv file. The statements of other files share the database: every request names the buyer of this
// file (userId), so only its statements are counted.
//
// The data is one buyer with twelve statements, each for an order of its own (price 10, no delivery
// price, so the money of a row is 10 a unit):
//   A  admin, other/defect, 1 unit      the goods are expected, nothing told of the parcel
//   B  admin, withdrawal/goodwill, 2    the goods are expected, nothing told, product 2
//   C  account, withdrawal, 3           the buyer told of the parcel, the shop has not confirmed it
//   D  account, withdrawal, 2           the buyer told of the parcel and the shop confirmed it
//   E  admin, other/defect, 1           the goods are on the shelf, the money is not back; variant 2
//   F  admin, other/defect, 2           the goods are on the shelf and the money is back: closed
//   G  admin, other/defect, 1           the shop does not accept the goods: closed, money refused
//   H  admin, other/defect, 1           the proof was confirmed and the money went back before the goods
//   I  admin, other/defect, 1           the goods are on the shelf, the last transfer failed
//   L  admin, other/defect, 1           the goods are on the shelf, the transfer waits for the provider
//   J  form without a code, withdrawal, 2   an admin checks it by hand, the goods are expected
//   K  form with the code, withdrawal, 1    the goods are expected
// Taking the goods in confirms the parcel they came in: E, F, G, I and L have the proof confirmed.

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
let product: TestProduct;
let secondProduct: TestProduct;
let secondVariantId: number;
const userIds: number[] = [];
const products: TestProduct[] = [];
let clock: { restore: () => void } | null = null;

const DAY = 86_400_000;
const HOUR = 3_600_000;

// no digit in the name or the email of the buyer: a number in the search must be an order number,
// not a part of an address
const letters = (text: string) => text.replace(/\d/g, (digit) => 'abcdefghij'[Number(digit)]!);
const tag = letters(uniqueTag());
const FORM_EMAIL = `form.${tag}@example.com`;

type Key = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'L' | 'J' | 'K';
const KEYS: Key[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'L', 'J', 'K'];
const ids = {} as Record<Key, number>;
const orderIds = {} as Record<Key, number>;

type Line = {
  id: number;
  code: string;
  orderId: number;
  order: { status: string; returnStatus: string };
  buyer: { id: number; alive: boolean };
  contact: { name: string; email: string };
  statedAt: string;
  daysSince: number;
  source: string;
  basis: string;
  reason: string | null;
  extendsId: number | null;
  closedAt: string | null;
  updatedAt: string;
  proof: { providedAt: string | null; confirmedAt: string | null };
  units: number;
  amount: number;
  refundedAmount: number;
  goods: { expected: number; received: number; declined: number };
  money: {
    notRefunded: number;
    pending: number;
    refunded: number;
    refused: number;
    failed: boolean;
  };
};
type Page = { items: Line[]; total: number; limit: number; nextCursor: string | null };

afterEach(() => {
  clock?.restore();
  clock = null;
});

const {
  post,
  shippedOrder,
  adminStatement,
  setGoods,
  confirmProof,
  withdrawFromAccount,
  tellOfParcel,
  formStatement: formStatementOf,
} = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });

const formStatement = (orderId: number, withCode: boolean) =>
  formStatementOf(orderId, withCode, FORM_EMAIL);

const queryOf = (query: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString();

// the list, narrowed to the buyer of this file unless the test names another one
const get = (query: Record<string, string | number> = {}, actor: TestUser | null = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/returns?${queryOf({ userId: buyer.id, ...query })}`,
    ...(actor ? { headers: { cookie: accessCookie(actor) } } : {}),
  });

const pageOf = async (query: Record<string, string | number> = {}): Promise<Page> => {
  const res = await get(query);
  expect(res.statusCode).toBe(200);
  return res.json();
};

const keyOf = (id: number) => KEYS.find((key) => ids[key] === id)!;

// the statements of the page as their letters, in the order the page has them
const keysIn = (page: Page) => page.items.map((line) => keyOf(line.id));

// the same, sorted: for the filters whose order is not the point
const setOf = async (query: Record<string, string | number> = {}) =>
  (keysIn(await pageOf({ limit: 100, ...query })) as string[]).sort();

const detailOf = async (returnId: number) =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/returns/${returnId}`,
      headers: { cookie: accessCookie(admin) },
    })
  ).json();

const lineOf = async (key: Key) => (await pageOf({ orderId: orderIds[key] })).items[0]!;

const newBuyer = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newBuyer({ role: 'ADMIN' });
  root = await newBuyer({ role: 'ROOT' });
  buyer = await newBuyer({ name: 'Anna Koval', email: `anna.${tag}@example.com` });

  product = await createProduct({ price: 10, stock: 100 });
  secondProduct = await createProduct({ price: 10, stock: 100 });
  secondVariantId = (await createVariant(secondProduct.id, { price: 10, stock: 100 })).id;
  products.push(product, secondProduct);

  const order = async (key: Key, item: Buyable, quantity: number) => {
    const placed = await shippedOrder(buyer, item, quantity);
    orderIds[key] = placed.orderId;
    return placed;
  };

  let placed = await order('A', product, 1);
  ids.A = (await adminStatement(placed.orderId, placed.itemId, 1)).id;

  placed = await order('B', secondProduct, 2);
  ids.B = (
    await adminStatement(placed.orderId, placed.itemId, 2, {
      basis: 'withdrawal',
      reason: 'goodwill',
    })
  ).id;

  placed = await order('C', product, 3);
  ids.C = await withdrawFromAccount(buyer, placed.orderId);
  await tellOfParcel(buyer, placed.orderId, ids.C);

  placed = await order('D', product, 2);
  ids.D = await withdrawFromAccount(buyer, placed.orderId);
  await tellOfParcel(buyer, placed.orderId, ids.D);
  await confirmProof(ids.D);

  placed = await order('E', { variantId: secondVariantId }, 1);
  let card = await adminStatement(placed.orderId, placed.itemId, 1);
  ids.E = card.id;
  await setGoods(card, 1, 'to_stock');

  placed = await order('F', product, 2);
  card = await adminStatement(placed.orderId, placed.itemId, 2);
  ids.F = card.id;
  await setGoods(card, 2, 'to_stock');
  await refundReturn(admin.id, card.id);

  placed = await order('G', product, 1);
  card = await adminStatement(placed.orderId, placed.itemId, 1);
  ids.G = card.id;
  await setGoods(card, 1, 'not_accepted', { notAcceptedReason: 'unsealed' });

  placed = await order('H', product, 1);
  card = await adminStatement(placed.orderId, placed.itemId, 1);
  ids.H = card.id;
  await confirmProof(card.id);
  await refundReturn(admin.id, card.id);

  placed = await order('I', product, 1);
  card = await adminStatement(placed.orderId, placed.itemId, 1);
  ids.I = card.id;
  await setGoods(card, 1, 'to_stock');
  await failReturnRefund(admin.id, card.id);

  placed = await order('L', product, 1);
  card = await adminStatement(placed.orderId, placed.itemId, 1);
  ids.L = card.id;
  await setGoods(card, 1, 'to_stock');
  await beginReturnRefund(admin.id, card.id);

  placed = await order('J', product, 2);
  ids.J = await formStatement(placed.orderId, false);

  placed = await order('K', product, 1);
  ids.K = await formStatement(placed.orderId, true);
}, 120_000);

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('GET /api/returns for who may read it', () => {
  it.each([
    ['an admin', () => admin],
    ['a root', () => root],
  ])('gives the list to %s', async (_who, actor) => {
    const res = await get({ limit: 1 }, actor());

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(KEYS.length);
  });

  it('refuses a buyer and a visitor without a login (403 INSUFFICIENT_ROLE)', async () => {
    const byBuyer = await get({}, buyer);
    const byGuest = await get({}, null);

    for (const res of [byBuyer, byGuest]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    }
  });

  it('refuses the csv to a buyer as well', async () => {
    const res = await get({ format: 'csv' }, buyer);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('a line of the list', () => {
  // what each statement is by the rules: the units of its rows, the money and the goods by state
  const FACTS: Record<
    Key,
    {
      source: string;
      basis: string;
      reason: string | null;
      units: number;
      refunded: number;
      goods: [expected: number, received: number, declined: number];
      money: [notRefunded: number, pending: number, refunded: number, refused: number];
      failed?: boolean;
      closed: boolean;
      proof: [provided: boolean, confirmed: boolean];
      order: [status: string, returnStatus: string];
    }
  > = {
    A: {
      source: 'admin',
      basis: 'other',
      reason: 'defect',
      units: 1,
      refunded: 0,
      goods: [1, 0, 0],
      money: [1, 0, 0, 0],
      closed: false,
      proof: [false, false],
      order: ['shipped', 'open'],
    },
    B: {
      source: 'admin',
      basis: 'withdrawal',
      reason: 'goodwill',
      units: 2,
      refunded: 0,
      goods: [2, 0, 0],
      money: [2, 0, 0, 0],
      closed: false,
      proof: [false, false],
      order: ['shipped', 'open'],
    },
    C: {
      source: 'account',
      basis: 'withdrawal',
      reason: null,
      units: 3,
      refunded: 0,
      goods: [3, 0, 0],
      money: [3, 0, 0, 0],
      closed: false,
      proof: [true, false],
      order: ['shipped', 'open'],
    },
    D: {
      source: 'account',
      basis: 'withdrawal',
      reason: null,
      units: 2,
      refunded: 0,
      goods: [2, 0, 0],
      money: [2, 0, 0, 0],
      closed: false,
      proof: [true, true],
      order: ['shipped', 'open'],
    },
    E: {
      source: 'admin',
      basis: 'other',
      reason: 'defect',
      units: 1,
      refunded: 0,
      goods: [0, 1, 0],
      money: [1, 0, 0, 0],
      closed: false,
      proof: [false, true],
      order: ['shipped', 'open'],
    },
    // every unit of the order is back with its money: the order is cancelled
    F: {
      source: 'admin',
      basis: 'other',
      reason: 'defect',
      units: 2,
      refunded: 20,
      goods: [0, 2, 0],
      money: [0, 0, 2, 0],
      closed: true,
      proof: [false, true],
      order: ['cancelled', 'full'],
    },
    G: {
      source: 'admin',
      basis: 'other',
      reason: 'defect',
      units: 1,
      refunded: 0,
      goods: [0, 0, 1],
      money: [0, 0, 0, 1],
      closed: true,
      proof: [false, true],
      order: ['shipped', 'declined'],
    },
    H: {
      source: 'admin',
      basis: 'other',
      reason: 'defect',
      units: 1,
      refunded: 10,
      goods: [1, 0, 0],
      money: [0, 0, 1, 0],
      closed: false,
      proof: [false, true],
      order: ['shipped', 'open_partial'],
    },
    I: {
      source: 'admin',
      basis: 'other',
      reason: 'defect',
      units: 1,
      refunded: 0,
      goods: [0, 1, 0],
      money: [1, 0, 0, 0],
      failed: true,
      closed: false,
      proof: [false, true],
      order: ['shipped', 'open'],
    },
    L: {
      source: 'admin',
      basis: 'other',
      reason: 'defect',
      units: 1,
      refunded: 0,
      goods: [0, 1, 0],
      money: [0, 1, 0, 0],
      closed: false,
      proof: [false, true],
      order: ['shipped', 'open'],
    },
    J: {
      source: 'form_manual',
      basis: 'withdrawal',
      reason: null,
      units: 2,
      refunded: 0,
      goods: [2, 0, 0],
      money: [2, 0, 0, 0],
      closed: false,
      proof: [false, false],
      order: ['shipped', 'open'],
    },
    K: {
      source: 'form_code',
      basis: 'withdrawal',
      reason: null,
      units: 1,
      refunded: 0,
      goods: [1, 0, 0],
      money: [1, 0, 0, 0],
      closed: false,
      proof: [false, false],
      order: ['shipped', 'open'],
    },
  };

  it.each(KEYS)('gives the units, the goods and the money of the statement %s', async (key) => {
    const fact = FACTS[key];
    const contact =
      fact.source === 'form_manual' || fact.source === 'form_code'
        ? { name: 'Anna Koval', email: FORM_EMAIL }
        : { name: 'Anna Koval', email: buyer.email };

    const line = await lineOf(key);

    expect(line).toEqual({
      id: ids[key],
      // the only statement of its order: number 1
      code: `${fact.basis === 'withdrawal' ? 'W' : 'R'}${orderIds[key]}-1`,
      orderId: orderIds[key],
      order: { status: fact.order[0], returnStatus: fact.order[1] },
      buyer: { id: buyer.id, alive: true },
      contact,
      statedAt: expect.any(String),
      daysSince: 0,
      source: fact.source,
      basis: fact.basis,
      reason: fact.reason,
      extendsId: null,
      closedAt: fact.closed ? expect.any(String) : null,
      updatedAt: expect.any(String),
      proof: {
        providedAt: fact.proof[0] ? expect.any(String) : null,
        confirmedAt: fact.proof[1] ? expect.any(String) : null,
      },
      acceptedAt: null,
      units: fact.units,
      amount: fact.units * 10,
      refundedAmount: fact.refunded,
      // what an open statement still has to send: its rows owed (no delivery, no way back here)
      moneyLeft: fact.closed ? null : fact.money[0] * 10,
      goods: { expected: fact.goods[0], received: fact.goods[1], declined: fact.goods[2] },
      money: {
        notRefunded: fact.money[0],
        pending: fact.money[1],
        refunded: fact.money[2],
        refused: fact.money[3],
        failed: fact.failed ?? false,
      },
    });
  });

  it('counts the units of a statement split by a result by the state of each part', async () => {
    const placed = await shippedOrder(await newBuyer(), product, 3);
    const card = await adminStatement(placed.orderId, placed.itemId, 3);
    // one unit is on the shelf, one is refused, one is still expected
    await setGoods(card, 1, 'to_stock');
    const refused = await post(`/api/returns/${card.id}/receive`, {
      parcel: { buyerPaid: 0 },
      results: [
        {
          itemId: (await detailOf(card.id)).items.find(
            (row: { goods: string }) => row.goods === 'expected',
          ).id,
          quantity: 1,
          goods: 'not_accepted',
          notAcceptedReason: 'used',
        },
      ],
    });
    expect(refused.statusCode).toBe(200);

    const line = (await pageOf({ userId: placed.buyerId, orderId: placed.orderId })).items[0]!;

    expect(line).toMatchObject({
      units: 3,
      amount: 30,
      goods: { expected: 1, received: 1, declined: 1 },
      money: { notRefunded: 2, pending: 0, refunded: 0, refused: 1, failed: false },
      closedAt: null,
    });
  });

  it('dates the statement now and counts the whole days since it from the clock of the app', async () => {
    const before = (await lineOf('A')).daysSince;
    clock = moveClock(3 * DAY + HOUR);

    const after = (await lineOf('A')).daysSince;

    expect(before).toBe(0);
    expect(after).toBe(3);
  });
});

describe('the page, the total and the cursor', () => {
  it('gives twenty lines by default and the total of the filter', async () => {
    const page = await pageOf();

    expect(page.limit).toBe(20);
    expect(page.items).toHaveLength(KEYS.length);
    expect(page.total).toBe(KEYS.length);
    expect(page.nextCursor).toBeNull();
  });

  it('gives the total of the filter, not of the page, and a cursor while there is more', async () => {
    const page = await pageOf({ limit: 5 });

    expect(page.limit).toBe(5);
    expect(page.items).toHaveLength(5);
    expect(page.total).toBe(KEYS.length);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('gives the total of a narrower filter on every page', async () => {
    const first = await pageOf({ state: 'open', limit: 4 });
    const second = await pageOf({ state: 'open', limit: 4, cursor: first.nextCursor! });

    // F and G are closed
    expect(first.total).toBe(KEYS.length - 2);
    expect(second.total).toBe(KEYS.length - 2);
    expect(second.items).toHaveLength(4);
  });

  it('ends the last page without a cursor when the page is exactly full', async () => {
    const page = await pageOf({ limit: KEYS.length });

    expect(page.items).toHaveLength(KEYS.length);
    expect(page.nextCursor).toBeNull();
  });

  it('gives an empty page with the total 0 for a filter nothing meets', async () => {
    const page = await pageOf({ reason: 'damaged' });

    expect(page).toEqual({ items: [], total: 0, limit: 20, nextCursor: null });
  });

  it('refuses a cursor of another sort or direction (400 CURSOR_INVALID)', async () => {
    const page = await pageOf({ limit: 2, sortBy: 'statedAt', sortDir: 'desc' });
    const cursor = page.nextCursor!;

    const otherSort = await get({ limit: 2, sortBy: 'amount', sortDir: 'desc', cursor });
    const otherDirection = await get({ limit: 2, sortBy: 'statedAt', sortDir: 'asc', cursor });
    const garbage = await get({ cursor: 'AAAA' });
    const notJson = await get({ cursor: Buffer.from('not json').toString('base64url') });

    for (const res of [otherSort, otherDirection, garbage, notJson]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    }
  });

  it('refuses a cursor with a date that is none or a number that is none (400 CURSOR_INVALID), not a server error', async () => {
    const made = (v: string, sortBy: string) =>
      [encodeCursor({ id: 1, v, s: `${sortBy}:desc` } as never), sortBy] as const;

    for (const [cursor, sortBy] of [
      made('2026-13-45T00:00:00.000Z', 'statedAt'),
      made('0000-01-01T00:00:00.000Z', 'statedAt'),
      made('2026-11-03', 'statedAt'),
      made('abc', 'amount'),
      made('1; select 1', 'amount'),
    ]) {
      const res = await get({ cursor, sortBy, sortDir: 'desc' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    }
  });

  // J is the one statement of the form without the code, and no admin accepted it
  it('lists the statements of the form without the code by the check of an admin', async () => {
    expect(await setOf({ accepted: 'false' })).toEqual(['J']);
    expect(await setOf({ accepted: 'true' })).toEqual([]);
  });

  it('refuses a cursor made of characters a cursor never has (400 VALIDATION_ERROR)', async () => {
    const res = await get({ cursor: 'a b!' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it.each([
    ['limit 0', { limit: 0 }],
    ['limit 101', { limit: 101 }],
    ['a state there is not', { state: 'maybe' }],
    ['a goods filter there is not', { goods: 'lost' }],
    ['a money filter there is not', { money: 'half' }],
    ['a source there is not', { source: 'phone' }],
    ['a basis there is not', { basis: 'whim' }],
    ['a reason there is not', { reason: 'whim' }],
    ['a sort there is not', { sortBy: 'buyer' }],
    ['a direction there is not', { sortDir: 'up' }],
    ['a format there is not', { format: 'xml' }],
    ['an order id of 0', { orderId: 0 }],
    ['an empty text', { q: '' }],
    ['a date that is not one', { statedFrom: 'yesterday' }],
    ['0 days', { olderThanDays: 0 }],
    ['days over the bound', { moneyDueForDays: 3651 }],
  ])('refuses %s (400 VALIDATION_ERROR)', async (_what, query) => {
    const res = await get(query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('takes 100 lines in a page', async () => {
    const res = await get({ limit: 100 });

    expect(res.statusCode).toBe(200);
    expect(res.json().limit).toBe(100);
  });
});

describe('the filters', () => {
  it('lists the statements of the buyer of the order, and of no other buyer', async () => {
    const other = await newBuyer({ name: 'Other Buyer' });

    const ofOther = await app.inject({
      method: 'GET',
      url: `/api/returns?${queryOf({ userId: other.id })}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(await setOf()).toEqual([...KEYS].sort());
    expect(ofOther.json()).toEqual({ items: [], total: 0, limit: 20, nextCursor: null });
  });

  it.each([
    ['open', ['A', 'B', 'C', 'D', 'E', 'H', 'I', 'J', 'K', 'L']],
    ['closed', ['F', 'G']],
  ])('lists the %s statements (state)', async (state, expected) => {
    expect(await setOf({ state })).toEqual(expected);
  });

  // waiting: some row waits for its goods; the buyer's word of the parcel and the shop's check of
  // it split them; received: none waits
  it.each([
    ['waiting', ['A', 'B', 'C', 'D', 'H', 'J', 'K']],
    // C was told of and not confirmed, D was told of and confirmed; H was confirmed by the shop
    // without a word of the buyer: the shop vouched for the parcel, so it is no statement without
    // a proof
    ['waiting_no_proof', ['A', 'B', 'J', 'K']],
    ['proof_provided', ['C']],
    ['received', ['E', 'F', 'G', 'I', 'L']],
  ])('lists the statements by the goods: %s', async (goods, expected) => {
    expect(await setOf({ goods })).toEqual(expected);
  });

  it.each([
    ['not_refunded', ['A', 'B', 'C', 'D', 'E', 'I', 'J', 'K']],
    ['pending', ['L']],
    ['failed', ['I']],
    ['refunded', ['F', 'H']],
    ['refused', ['G']],
  ])('lists the statements with a row whose money is %s', async (money, expected) => {
    expect(await setOf({ money })).toEqual(expected);
  });

  it.each([
    ['admin', ['A', 'B', 'E', 'F', 'G', 'H', 'I', 'L']],
    ['account', ['C', 'D']],
    ['form_manual', ['J']],
    ['form_code', ['K']],
  ])('lists the statements that came from %s (source)', async (source, expected) => {
    expect(await setOf({ source })).toEqual(expected);
  });

  it.each([
    ['withdrawal', ['B', 'C', 'D', 'J', 'K']],
    ['other', ['A', 'E', 'F', 'G', 'H', 'I', 'L']],
  ])('lists the statements of the basis %s', async (basis, expected) => {
    expect(await setOf({ basis })).toEqual(expected);
  });

  it.each([
    ['defect', ['A', 'E', 'F', 'G', 'H', 'I', 'L']],
    ['goodwill', ['B']],
    ['damaged', []],
  ])(
    'lists the statements of the reason %s, none of those with no reason',
    async (reason, expected) => {
      expect(await setOf({ reason })).toEqual(expected);
    },
  );

  it('lists the statements of one order, and none when the order is of another buyer', async () => {
    const other = await newBuyer({ name: 'Other Buyer' });
    const placed = await shippedOrder(other, product, 1);
    await adminStatement(placed.orderId, placed.itemId, 1);

    expect(await setOf({ orderId: orderIds.E })).toEqual(['E']);
    // both filters hold: the order is not of this buyer
    expect(await setOf({ orderId: placed.orderId })).toEqual([]);
  });

  it('lists the statements with a row of the product or of the variant', async () => {
    // product 2 holds B (its first variant) and E (its second variant)
    expect(await setOf({ productId: secondProduct.id })).toEqual(['B', 'E']);
    expect(await setOf({ variantId: secondProduct.variantId })).toEqual(['B']);
    expect(await setOf({ variantId: secondVariantId })).toEqual(['E']);
    expect(await setOf({ productId: product.id })).toEqual(
      KEYS.filter((key) => key !== 'B' && key !== 'E').sort(),
    );
    // the product and a variant of another product meet in no statement
    expect(await setOf({ productId: product.id, variantId: secondVariantId })).toEqual([]);
  });

  it('meets all the filters at once', async () => {
    expect(await setOf({ state: 'open', goods: 'waiting', source: 'account' })).toEqual(['C', 'D']);
    expect(await setOf({ state: 'open', goods: 'received', money: 'not_refunded' })).toEqual([
      'E',
      'I',
    ]);
    expect(await setOf({ goods: 'received', money: 'failed' })).toEqual(['I']);
    expect(await setOf({ source: 'admin', basis: 'withdrawal' })).toEqual(['B']);
    expect(await setOf({ state: 'closed', reason: 'defect' })).toEqual(['F', 'G']);
    expect(await setOf({ state: 'closed', money: 'refunded', goods: 'received' })).toEqual(['F']);
    expect(await setOf({ state: 'closed', goods: 'waiting' })).toEqual([]);
  });

  it('keeps the total of a filter with the page smaller than it', async () => {
    const page = await pageOf({ source: 'admin', limit: 3 });

    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(8);
  });
});

describe('the search (q)', () => {
  it('takes a whole number for the number of an order', async () => {
    expect(await setOf({ q: orderIds.G })).toEqual(['G']);
    expect(await setOf({ q: orderIds.K })).toEqual(['K']);
  });

  it('takes a whole number for a part of an email or a name too', async () => {
    // a buyer with digits in the address: the number finds their statement though it is no order
    const digits = '86753099';
    const numbered = await newBuyer({
      name: 'Numbered Buyer',
      email: `numbered.${digits}.${tag}@example.com`,
    });
    const placed = await shippedOrder(numbered, product, 1);
    const card = await adminStatement(placed.orderId, placed.itemId, 1);

    const res = await app.inject({
      method: 'GET',
      url: `/api/returns?${queryOf({ userId: numbered.id, q: digits })}`,
      headers: { cookie: accessCookie(admin) },
    });
    const none = await app.inject({
      method: 'GET',
      url: `/api/returns?${queryOf({ userId: numbered.id, q: '86753098' })}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(res.json().items.map((row: Line) => row.id)).toEqual([card.id]);
    expect(none.json().total).toBe(0);
  });

  it('takes a number that is no order as nothing but a part of a name or an email', async () => {
    expect(await setOf({ q: 2_000_000_000 })).toEqual([]);
  });

  it('finds a part of the name of the contact without the case', async () => {
    expect(await setOf({ q: 'koval' })).toEqual([...KEYS].sort());
    expect(await setOf({ q: 'ANNA K' })).toEqual([...KEYS].sort());
    expect(await setOf({ q: 'nobody here' })).toEqual([]);
  });

  it('finds a part of the email of the contact without the case: the form email is not the account email', async () => {
    expect(await setOf({ q: `FORM.${tag}` })).toEqual(['J', 'K']);
    expect(await setOf({ q: `ANNA.${tag}` })).toEqual(
      KEYS.filter((key) => key !== 'J' && key !== 'K').sort(),
    );
  });

  it('takes % and _ and a backslash for the characters they are, not for wildcards', async () => {
    const mark = tag.replace(/-/g, '');
    const names = {
      underscore: `Zed_Pat${mark}`,
      lookalike: `ZedXPat${mark}`,
      percent: `100% Sure${mark}`,
      percentLookalike: `100 Sure${mark}`,
      backslash: `Dir\\Name${mark}`,
      backslashLookalike: `DirName${mark}`,
    };
    const stated: Record<string, number> = {};
    for (const [label, name] of Object.entries(names)) {
      const user = await newBuyer({ name });
      const placed = await shippedOrder(user, product, 1);
      stated[label] = (await adminStatement(placed.orderId, placed.itemId, 1)).id;
    }
    const find = async (q: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/returns?${queryOf({ q, limit: 100 })}`,
        headers: { cookie: accessCookie(admin) },
      });
      expect(res.statusCode).toBe(200);
      return (res.json().items as Line[]).map((row) => row.id).sort((a, b) => a - b);
    };
    const sorted = (...labels: string[]) =>
      labels.map((label) => stated[label]!).sort((a, b) => a - b);

    // the underscore is no "any one character"
    expect(await find(names.underscore)).toEqual(sorted('underscore'));
    expect(await find(`Zed_Pat${mark}`.toLowerCase())).toEqual(sorted('underscore'));
    // the percent is no "any run of characters"
    expect(await find(names.percent)).toEqual(sorted('percent'));
    expect(await find(`100%`)).toEqual(expect.arrayContaining(sorted('percent')));
    expect(await find(`100%`)).not.toContain(stated.percentLookalike);
    // the backslash is no escape
    expect(await find(names.backslash)).toEqual(sorted('backslash'));
    // a lone wildcard finds only what holds it, not everything
    const lonePercent = await find('%');
    expect(lonePercent).toContain(stated.percent);
    expect(lonePercent).not.toContain(stated.percentLookalike);
    expect(lonePercent).not.toContain(ids.A);
    const loneUnderscore = await find(`_Pat${mark}`);
    expect(loneUnderscore).toEqual(sorted('underscore'));
  });
});

describe('the periods', () => {
  // the times of the statements as the list gives them, oldest first
  const statedTimes = async () => {
    const page = await pageOf({ limit: 100, sortBy: 'statedAt', sortDir: 'asc' });
    return page.items.map((line) => ({ key: keyOf(line.id), at: Date.parse(line.statedAt) }));
  };

  it('takes the statements stated from a time on, the time itself too (statedFrom)', async () => {
    const times = await statedTimes();
    const from = times[4]!.at;

    const found = await setOf({ statedFrom: new Date(from).toISOString() });

    expect(found).toEqual(
      times
        .filter((t) => t.at >= from)
        .map((t) => t.key)
        .sort(),
    );
    expect(found.length).toBeLessThan(KEYS.length);
  });

  it('takes the statements stated before a time, not the time itself (statedTo)', async () => {
    const times = await statedTimes();
    const to = times[4]!.at;

    const found = await setOf({ statedTo: new Date(to).toISOString() });

    expect(found).toEqual(
      times
        .filter((t) => t.at < to)
        .map((t) => t.key)
        .sort(),
    );
    expect(found).not.toContain(times[4]!.key);
  });

  it('takes the statements in a window of the two', async () => {
    const times = await statedTimes();
    const from = times[2]!.at;
    const to = times[7]!.at;

    const found = await setOf({
      statedFrom: new Date(from).toISOString(),
      statedTo: new Date(to).toISOString(),
    });

    expect(found).toEqual(
      times
        .filter((t) => t.at >= from && t.at < to)
        .map((t) => t.key)
        .sort(),
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('takes the statements closed from a time on and before a time (closedFrom, closedTo)', async () => {
    const closed = (await pageOf({ state: 'closed', limit: 100 })).items
      .map((line) => ({ key: keyOf(line.id), at: Date.parse(line.closedAt!) }))
      .sort((a, b) => a.at - b.at);
    expect(closed.map((c) => c.key).sort()).toEqual(['F', 'G']);
    const [first, second] = closed as [(typeof closed)[number], (typeof closed)[number]];

    // from is inclusive, to is not; a statement not closed is in neither
    expect(await setOf({ closedFrom: new Date(second.at).toISOString() })).toEqual(
      closed
        .filter((c) => c.at >= second.at)
        .map((c) => c.key)
        .sort(),
    );
    expect(await setOf({ closedTo: new Date(second.at).toISOString() })).toEqual(
      closed
        .filter((c) => c.at < second.at)
        .map((c) => c.key)
        .sort(),
    );
    expect(await setOf({ closedFrom: new Date(first.at - 60_000).toISOString() })).toEqual([
      'F',
      'G',
    ]);
    expect(await setOf({ closedTo: new Date(first.at - 60_000).toISOString() })).toEqual([]);
    expect(await setOf({ closedFrom: new Date(first.at + 365 * DAY).toISOString() })).toEqual([]);
  });

  it('takes the statements with a row whose money went back in a period (refundedFrom, refundedTo)', async () => {
    // the money of a row went back when the line of the money journal that sent it was written
    const refundedAt = async (key: Key) => {
      const card = await detailOf(ids[key]);
      const row = card.items.find((one: { money: string }) => one.money === 'refunded');
      return Date.parse(
        card.money.find((move: { id: number }) => move.id === row.moneyLogId).createdAt,
      );
    };
    const f = await refundedAt('F');
    const h = await refundedAt('H');
    const later = Math.max(f, h);
    const earlier = Math.min(f, h);

    expect(await setOf({ refundedFrom: new Date(earlier - 60_000).toISOString() })).toEqual([
      'F',
      'H',
    ]);
    expect(await setOf({ refundedFrom: new Date(later + 60_000).toISOString() })).toEqual([]);
    expect(await setOf({ refundedTo: new Date(earlier).toISOString() })).toEqual([]);
    expect(await setOf({ refundedTo: new Date(later + 60_000).toISOString() })).toEqual(['F', 'H']);
    // a statement whose money is not back is in no period
    expect(
      await setOf({
        refundedFrom: new Date(earlier - 60_000).toISOString(),
        refundedTo: new Date(later + 60_000).toISOString(),
      }),
    ).toEqual(['F', 'H']);
  });
});

// The "days" filters count from the clock of the app (Date.now): a test ages the statements by
// moving the clock. A margin of an hour on both sides of the day keeps the check clear of the small
// difference the clock of the database may have from the clock of the test
describe('the filters of days, with the clock moved', () => {
  const ALL = [...KEYS].sort();

  it('takes the statements stated more than so many days ago (olderThanDays)', async () => {
    expect(await setOf({ olderThanDays: 2 })).toEqual([]);

    clock = moveClock(2 * DAY - HOUR);
    expect(await setOf({ olderThanDays: 2 })).toEqual([]);
    clock.restore();

    clock = moveClock(2 * DAY + HOUR);
    expect(await setOf({ olderThanDays: 2 })).toEqual(ALL);
    expect(await setOf({ olderThanDays: 3 })).toEqual([]);
  });

  it('takes the statements whose money is due and not back, so many days after the statement (moneyDueForDays)', async () => {
    // due: the goods are in (E, I, L) or the shop confirmed the proof of the parcel (D); not due:
    // goods still expected without a confirmed proof (A, B, C, J, K), money already back or refused
    // (F, G, H)
    expect(await setOf({ moneyDueForDays: 5 })).toEqual([]);

    clock = moveClock(5 * DAY - HOUR);
    expect(await setOf({ moneyDueForDays: 5 })).toEqual([]);
    clock.restore();

    clock = moveClock(5 * DAY + HOUR);
    expect(await setOf({ moneyDueForDays: 5 })).toEqual(['D', 'E', 'I', 'L']);
    expect(await setOf({ moneyDueForDays: 5, goods: 'received' })).toEqual(['E', 'I', 'L']);
    expect(await setOf({ moneyDueForDays: 5, state: 'closed' })).toEqual([]);
    expect(await setOf({ moneyDueForDays: 6 })).toEqual([]);
  });

  // the law gives the shop 14 days from the statement for the money (6.1), which it may hold until
  // the goods are in or the proof is confirmed: the statements whose money is due (D, E, I, L) are
  // overdue after them, the ones that wait for the goods (A, B, C, J, K) are not
  it('takes the statements whose 14 days of the money are over (moneyOverdue)', async () => {
    const owing = ['D', 'E', 'I', 'L'];
    expect(await setOf({ moneyOverdue: 'true' })).toEqual([]);

    clock = moveClock(14 * DAY - HOUR);
    expect(await setOf({ moneyOverdue: 'true' })).toEqual([]);
    clock.restore();

    clock = moveClock(14 * DAY + HOUR);
    expect(await setOf({ moneyOverdue: 'true' })).toEqual(owing);
    expect(await setOf({ moneyOverdue: 'false' })).toEqual([
      'A',
      'B',
      'C',
      'F',
      'G',
      'H',
      'J',
      'K',
    ]);
  });

  it('takes the statements whose 14 days of the money end within so many days (moneyDueWithinDays)', async () => {
    const owing = ['D', 'E', 'I', 'L'];
    // the end is 14 days away: not within 3
    expect(await setOf({ moneyDueWithinDays: 3 })).toEqual([]);

    clock = moveClock(12 * DAY);
    expect(await setOf({ moneyDueWithinDays: 3 })).toEqual(owing);
    expect(await setOf({ moneyDueWithinDays: 1 })).toEqual([]);
    clock.restore();

    // over already: it is overdue, not due
    clock = moveClock(15 * DAY);
    expect(await setOf({ moneyDueWithinDays: 3 })).toEqual([]);
  });

  it('sorts by the end of the days of the money that is due, the others last (sortBy=moneyDeadline)', async () => {
    const page = await pageOf({ limit: 100, sortBy: 'moneyDeadline', sortDir: 'asc' });
    const keys = keysIn(page) as string[];

    // the ones whose money is due come first, by the time they were stated; the others owe none yet
    expect(keys.slice(0, 4)).toEqual(['D', 'E', 'I', 'L']);
    expect(keys.slice(4).sort()).toEqual(['A', 'B', 'C', 'F', 'G', 'H', 'J', 'K']);
  });

  // a chain of extensions (6.1): the statement that is extended and the one that extends it
  it('takes the statements of a chain of extensions, or the ones on their own (extended)', async () => {
    const other = await newBuyer();
    const placed = await shippedOrder(other, product, 2);
    const first = await adminStatement(placed.orderId, placed.itemId, 1);
    const second = await adminStatement(placed.orderId, placed.itemId, 1, { extendsId: first.id });
    const alone = await shippedOrder(other, product, 1);
    const single = await adminStatement(alone.orderId, alone.itemId, 1);
    const idsOf = async (query: Record<string, string>) =>
      (await get({ userId: other.id, limit: 100, ...query }))
        .json()
        .items.map((line: { id: number }) => line.id)
        .sort((a: number, b: number) => a - b);

    expect(await idsOf({ extended: 'true' })).toEqual([first.id, second.id]);
    expect(await idsOf({ extended: 'false' })).toEqual([single.id]);
  });

  it('takes the statements whose money went back so many days ago and whose goods are not in (paidAheadForDays)', async () => {
    // only H: its money went back with the goods still expected
    expect(await setOf({ paidAheadForDays: 4 })).toEqual([]);

    clock = moveClock(4 * DAY - HOUR);
    expect(await setOf({ paidAheadForDays: 4 })).toEqual([]);
    clock.restore();

    clock = moveClock(4 * DAY + HOUR);
    expect(await setOf({ paidAheadForDays: 4 })).toEqual(['H']);
    expect(await setOf({ paidAheadForDays: 5 })).toEqual([]);
  });

  it('takes the statements whose buyer told of the parcel more than so many days ago (proofOlderThanDays)', async () => {
    // the buyer told of the parcel of C and D; H was confirmed without a word of the buyer
    expect(await setOf({ proofOlderThanDays: 3 })).toEqual([]);

    clock = moveClock(3 * DAY - HOUR);
    expect(await setOf({ proofOlderThanDays: 3 })).toEqual([]);
    clock.restore();

    clock = moveClock(3 * DAY + HOUR);
    expect(await setOf({ proofOlderThanDays: 3 })).toEqual(['C', 'D']);
    expect(await setOf({ proofOlderThanDays: 3, goods: 'proof_provided' })).toEqual(['C']);
  });

  it('meets the days with the other filters', async () => {
    clock = moveClock(30 * DAY);

    expect(await setOf({ olderThanDays: 20, goods: 'waiting_no_proof', state: 'open' })).toEqual([
      'A',
      'B',
      'J',
      'K',
    ]);
    expect(await setOf({ olderThanDays: 20, source: 'form_manual' })).toEqual(['J']);
  });
});

describe('the sorts', () => {
  type SortBy = 'statedAt' | 'closedAt' | 'updatedAt' | 'amount';

  // the value a sort goes by; a statement not closed has the beginning of time for its closing
  const valueOf = (sortBy: SortBy, line: Line): number => {
    if (sortBy === 'statedAt') return Date.parse(line.statedAt);
    if (sortBy === 'updatedAt') return Date.parse(line.updatedAt);
    if (sortBy === 'closedAt') return line.closedAt ? Date.parse(line.closedAt) : 0;
    return line.amount;
  };

  // the order of the rule: by the value in the direction asked, then by the id in the same direction
  const expectedIds = (lines: Line[], sortBy: SortBy, sortDir: 'asc' | 'desc') =>
    [...lines]
      .sort((a, b) => {
        const byValue = valueOf(sortBy, a) - valueOf(sortBy, b);
        const order = byValue !== 0 ? byValue : a.id - b.id;
        return sortDir === 'asc' ? order : -order;
      })
      .map((line) => line.id);

  it.each(
    (['statedAt', 'closedAt', 'updatedAt', 'amount'] as const).flatMap((sortBy) =>
      (['asc', 'desc'] as const).map((sortDir) => [sortBy, sortDir] as const),
    ),
  )(
    'sorts by %s %s and pages through the cursor without a repeat or a gap',
    async (sortBy, sortDir) => {
      const all = (await pageOf({ limit: 100 })).items;
      const wanted = expectedIds(all, sortBy, sortDir);

      const whole = await pageOf({ limit: 100, sortBy, sortDir });
      const seen: number[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      for (let turn = 0; turn < 10; turn += 1) {
        const page: Page = await pageOf({
          limit: 5,
          sortBy,
          sortDir,
          ...(cursor ? { cursor } : {}),
        });
        expect(page.total).toBe(KEYS.length);
        sizes.push(page.items.length);
        seen.push(...page.items.map((line) => line.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }

      expect(whole.items.map((line) => line.id)).toEqual(wanted);
      expect(sizes).toEqual([5, 5, 2]);
      expect(seen).toEqual(wanted);
      expect(new Set(seen).size).toBe(KEYS.length);
    },
  );

  it('sorts by the time it was stated, the newest first, when it is not asked', async () => {
    const page = await pageOf({ limit: 100 });
    const times = page.items.map((line) => Date.parse(line.statedAt));

    expect(times).toEqual([...times].sort((a, b) => b - a));
    // the statements were made in the order of the letters of the fixture
    expect(keysIn(page)).toEqual(['K', 'J', 'L', 'I', 'H', 'G', 'F', 'E', 'D', 'C', 'B', 'A']);
  });

  it('puts the statements that are not closed after the closed ones, newest first, by the closing', async () => {
    const page = await pageOf({ limit: 100, sortBy: 'closedAt' });
    const closedFirst = keysIn(page).slice(0, 2).sort();

    expect(closedFirst).toEqual(['F', 'G']);
    expect(page.items.slice(2).every((line) => line.closedAt === null)).toBe(true);
    // the closed ones, the later closing first
    expect(Date.parse(page.items[0]!.closedAt!)).toBeGreaterThanOrEqual(
      Date.parse(page.items[1]!.closedAt!),
    );
  });

  it('breaks the tie of equal sums by the id in the direction asked', async () => {
    // the sums are 10 (A, E, G, H, I, K, L), 20 (B, D, F, J) and 30 (C)
    const asc = await pageOf({ limit: 100, sortBy: 'amount', sortDir: 'asc' });
    const desc = await pageOf({ limit: 100, sortBy: 'amount', sortDir: 'desc' });
    const byIds = (page: Page, amount: number) =>
      page.items.filter((line) => line.amount === amount).map((line) => line.id);

    expect(asc.items.map((line) => line.amount)).toEqual([
      10, 10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 30,
    ]);
    expect(byIds(asc, 10)).toEqual(
      byIds(asc, 10)
        .slice()
        .sort((a, b) => a - b),
    );
    expect(byIds(desc, 10)).toEqual(
      byIds(desc, 10)
        .slice()
        .sort((a, b) => b - a),
    );
    expect(desc.items[0]!.id).toBe(ids.C);
  });

  it('moves a statement to the front of the sort by the last change when the statement changes', async () => {
    const own = await newBuyer({ name: 'Anna Koval' });
    const first = await shippedOrder(own, product, 1);
    const second = await shippedOrder(own, product, 1);
    const older = await adminStatement(first.orderId, first.itemId, 1);
    const newer = await adminStatement(second.orderId, second.itemId, 1);
    const order = async () =>
      (await pageOf({ userId: own.id, sortBy: 'updatedAt' })).items.map((line) => line.id);

    // the statement made last was changed last
    expect(await order()).toEqual([newer.id, older.id]);

    // the shop confirms the proof of the older one: it is the last changed now
    await confirmProof(older.id);

    expect(await order()).toEqual([older.id, newer.id]);
  });
});

describe('format=csv', () => {
  const HEADER = [
    'return_id',
    'code',
    'order_id',
    'stated_at',
    'days_since',
    'source',
    'basis',
    'reason',
    'contact_name',
    'contact_email',
    'account_alive',
    'order_status',
    'return_status',
    'units',
    'amount',
    'refunded_amount',
    'money_left',
    'goods_expected',
    'goods_received',
    'goods_declined',
    'money_not_refunded',
    'money_pending',
    'money_refunded',
    'money_refused',
    'transfer_failed',
    'proof_provided_at',
    'proof_confirmed_at',
    'accepted_at',
    'closed_at',
    'extends_id',
  ];

  // no cell of this data holds a comma or a quote, so a line splits at the commas
  const rowsOf = (body: string) => {
    expect(body.startsWith('﻿')).toBe(true);
    expect(body.endsWith('\r\n')).toBe(true);
    const lines = body.slice(1, -2).split('\r\n');
    return { header: lines[0]!.split(','), rows: lines.slice(1).map((line) => line.split(',')) };
  };

  it('gives a file of every statement of the filter, with a header and a line each', async () => {
    const res = await get({ format: 'csv' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    const today = new Date().toISOString().slice(0, 10);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="returns-${today}.csv"`);
    const { header, rows } = rowsOf(res.body);
    expect(header).toEqual(HEADER);
    expect(rows).toHaveLength(KEYS.length);
    expect(rows.every((row) => row.length === HEADER.length)).toBe(true);
  });

  it('gives every statement of the filter whatever the limit and the cursor, in the order asked', async () => {
    const res = await get({ format: 'csv', limit: 2, sortBy: 'amount', sortDir: 'asc' });
    const first = await pageOf({ limit: 2, sortBy: 'amount', sortDir: 'asc' });
    const resWithCursor = await get({
      format: 'csv',
      limit: 2,
      sortBy: 'amount',
      sortDir: 'asc',
      cursor: first.nextCursor!,
    });
    const asJson = await pageOf({ limit: 100, sortBy: 'amount', sortDir: 'asc' });

    const { rows } = rowsOf(res.body);
    expect(rows.map((row) => Number(row[0]))).toEqual(asJson.items.map((line) => line.id));
    expect(rowsOf(resWithCursor.body).rows).toEqual(rows);
  });

  it('gives the values of a statement the way the list does', async () => {
    const res = await get({ format: 'csv', orderId: orderIds.F });
    const line = await lineOf('F');

    const { rows } = rowsOf(res.body);

    expect(rows).toEqual([
      [
        String(ids.F),
        line.code,
        String(orderIds.F),
        line.statedAt,
        '0',
        'admin',
        'other',
        'defect',
        'Anna Koval',
        buyer.email,
        'yes',
        'cancelled',
        'full',
        '2',
        '20.00',
        '20.00',
        // closed: nothing left to send
        '',
        '0',
        '2',
        '0',
        '0',
        '0',
        '2',
        '0',
        'no',
        '',
        line.proof.confirmedAt!,
        '',
        line.closedAt!,
        '',
      ],
    ]);
  });

  it('marks the failed transfer, the proof and an empty reason', async () => {
    const failed = rowsOf((await get({ format: 'csv', orderId: orderIds.I })).body).rows[0]!;
    const proved = rowsOf((await get({ format: 'csv', orderId: orderIds.D })).body).rows[0]!;
    const line = await lineOf('D');

    expect(failed[HEADER.indexOf('transfer_failed')]).toBe('yes');
    expect(proved[HEADER.indexOf('reason')]).toBe('');
    expect(proved[HEADER.indexOf('proof_provided_at')]).toBe(line.proof.providedAt);
    expect(proved[HEADER.indexOf('proof_confirmed_at')]).toBe(line.proof.confirmedAt);
  });

  it('gives only the header for a filter nothing meets', async () => {
    const res = await get({ format: 'csv', reason: 'damaged' });

    expect(res.statusCode).toBe(200);
    const { header, rows } = rowsOf(res.body);
    expect(header).toEqual(HEADER);
    expect(rows).toEqual([]);
  });

  it('keeps the filter in the file', async () => {
    const res = await get({ format: 'csv', state: 'closed' });

    expect(
      rowsOf(res.body)
        .rows.map((row) => Number(row[0]))
        .sort((a, b) => a - b),
    ).toEqual([ids.F, ids.G].sort((a, b) => a - b));
  });

  it('gives the json when the format is json', async () => {
    const res = await get({ format: 'json', limit: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json().total).toBe(KEYS.length);
  });
});

describe('the buyer whose account is deleted', () => {
  it('stays in the list, marked as not alive, with the statement and its money as they were', async () => {
    const gone = await newBuyer({ name: 'Anna Koval' });
    const placed = await shippedOrder(gone, product, 1);
    const card = await adminStatement(placed.orderId, placed.itemId, 1);
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/users/me',
      headers: withCsrf(csrf, accessCookie(gone)),
      payload: { password: gone.password, confirmOpenOrders: true },
    });
    expect(deleted.statusCode).toBe(204);

    const alive = await get({ userId: gone.id });
    const csv = await get({ userId: gone.id, format: 'csv' });

    expect(alive.statusCode).toBe(200);
    expect(alive.json().total).toBe(1);
    expect(alive.json().items[0]).toMatchObject({
      id: card.id,
      buyer: { id: gone.id, alive: false },
      units: 1,
      amount: 10,
      goods: { expected: 1, received: 0, declined: 0 },
    });
    const columns = csv.body.slice(1).split('\r\n')[0]!.split(',');
    const row = csv.body.slice(1).split('\r\n')[1]!.split(',');
    expect(row[columns.indexOf('account_alive')]).toBe('no');
  });
});

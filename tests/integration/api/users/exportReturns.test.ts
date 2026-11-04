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
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import { refundReturn } from '../../../helpers/returns.js';

// the statements of withdrawal and of return in the export of a person's data, and the same export
// of another person for root: GET /api/users/me/export gives each order its statements with their
// rows (what is the person's own: their words, their data, their money, the parcel they sent),
// GET /api/users/:userId/export gives root the same set, also for a deleted account, and leaves a
// line in the admin log

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const flows = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  userIds.push(admin.id, root.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const exportOf = (cookie: string) =>
  app.inject({ method: 'GET', url: '/api/users/me/export', headers: cookie ? { cookie } : {} });

const exportOfUser = (id: number | string, cookie: string) =>
  app.inject({ method: 'GET', url: `/api/users/${id}/export`, headers: cookie ? { cookie } : {} });

// a buyer whose shipped order of three units was withdrawn from from the account, the parcel told
async function buyerWithStatement() {
  const buyer = await newUser({ name: 'Anna Koval' });
  const name = `Export return ${buyer.id}`;
  const product = await createProduct({ price: 10, stock: 10, name });
  products.push(product);

  const order = await flows.shippedOrder(buyer, product, 3);
  const returnId = await flows.withdrawFromAccount(buyer, order.orderId);
  await flows.tellOfParcel(buyer, order.orderId, returnId);

  return { buyer, product, name, orderId: order.orderId, returnId };
}

type Statement = {
  id: number;
  contact: { name: string; email: string };
  items: Array<Record<string, unknown>>;
} & Record<string, unknown>;

const returnsOf = (
  data: { orders: Array<{ id: number; returns: Statement[] }> },
  orderId: number,
) => data.orders.find((order) => order.id === orderId)!.returns;

describe('the statements of return in GET /api/users/me/export', () => {
  it('gives each order its statements with the person’s own data, their rows and the parcel they sent', async () => {
    const { buyer, product, name, orderId, returnId } = await buyerWithStatement();

    const res = await exportOf(accessCookie(buyer));

    expect(res.statusCode).toBe(200);
    const [statement] = returnsOf(res.json(), orderId);
    expect(statement).toMatchObject({
      id: returnId,
      extendsId: null,
      basis: 'withdrawal',
      source: 'account',
      statedAt: expect.any(String),
      contact: { name: 'Anna Koval', email: buyer.email },
      proof: {
        providedAt: expect.any(String),
        carrier: 'DHL',
        trackingNumber: 'JD0146000123',
        trackingUrl: null,
      },
      closedAt: null,
      items: [
        {
          productId: product.id,
          variantId: product.variantId,
          name,
          quantity: 3,
          money: 'not_refunded',
          amount: '30',
          deliveryShare: '0',
          shippingDeduction: '0',
          refundedAt: null,
          refusal: null,
          outside: null,
        },
      ],
    });
  });

  // the set is agreed field by field: a new column of the statement does not reach the person's
  // file by itself
  it('gives only the agreed fields of a statement and of a row', async () => {
    const { buyer, orderId } = await buyerWithStatement();

    const [statement] = returnsOf((await exportOf(accessCookie(buyer))).json(), orderId);

    expect(Object.keys(statement!).sort()).toEqual([
      'basis',
      'closedAt',
      'code',
      'contact',
      'description',
      'extendsId',
      'id',
      'ip',
      'items',
      'proof',
      'reason',
      'shippingReimbursement',
      'source',
      'statedAt',
      'userAgent',
    ]);
    expect(Object.keys(statement!.items[0]!).sort()).toEqual([
      'amount',
      'deliveryShare',
      'money',
      'name',
      'outside',
      'productId',
      'quantity',
      'refundedAt',
      'refusal',
      'shippingDeduction',
      'variantId',
    ]);
  });

  it('shows the money back with its date, and nothing of what became of the goods or of the provider', async () => {
    const { buyer, orderId, returnId } = await buyerWithStatement();
    const card = await flows.cardOf(returnId);
    await flows.setGoods(card, 3, 'to_stock');
    const refunded = await refundReturn(admin.id, returnId);

    const body = (await exportOf(accessCookie(buyer))).body;
    const [statement] = returnsOf(JSON.parse(body), orderId);

    expect(statement!.closedAt).toEqual(expect.any(String));
    expect(statement!.items[0]).toMatchObject({
      money: 'refunded',
      amount: '30',
      refundedAt: refunded.refundedAt.toISOString(),
    });
    // what the shop did with the goods, the ids of the provider and the admins stay out
    expect(body).not.toMatch(
      /to_stock|written_off|goodsSet|refundKey|refundId|re_test_|recordedBy/,
    );
    expect(body).not.toContain(admin.email);
  });

  it('says why the money of a row was refused, as the order of the buyer does', async () => {
    const { buyer, orderId, returnId } = await buyerWithStatement();
    const card = await flows.cardOf(returnId);
    await flows.setGoods(card, 3, 'not_accepted', { notAcceptedReason: 'unsealed' });

    const [statement] = returnsOf((await exportOf(accessCookie(buyer))).json(), orderId);

    expect(statement!.items).toEqual([
      expect.objectContaining({ money: 'refused', refusal: 'unsealed' }),
    ]);
  });

  // the address and the browser of a statement an admin made are of the admin: what the admins
  // did is not the person's data
  it('gives the address and the browser of the statements of the person only, never of an admin', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 10 });
    products.push(product);
    const order = await flows.shippedOrder(buyer, product, 2);
    await flows.adminStatement(order.orderId, order.itemId, 1);
    await flows.withdrawFromAccount(buyer, order.orderId);

    const statements = returnsOf((await exportOf(accessCookie(buyer))).json(), order.orderId);

    expect(statements.map((one) => one.source).sort()).toEqual(['account', 'admin']);
    expect(statements.find((one) => one.source === 'account')).toMatchObject({
      ip: expect.any(String),
      userAgent: expect.any(String),
    });
    expect(statements.find((one) => one.source === 'admin')).toMatchObject({
      ip: null,
      userAgent: null,
    });
  });

  it('gives an order without a statement an empty list, and no one the statements of another person', async () => {
    const { orderId } = await buyerWithStatement();
    const other = await newUser();
    const product = await createProduct({ price: 10, stock: 5 });
    products.push(product);
    const quiet = await flows.shippedOrder(other, product, 1);

    const data = (await exportOf(accessCookie(other))).json();

    expect(returnsOf(data, quiet.orderId)).toEqual([]);
    expect(data.orders.map((order: { id: number }) => order.id)).not.toContain(orderId);
    expect(JSON.stringify(data)).not.toContain('JD0146000123');
  });

  it('gives the data of a statement made by the public form the way it was written', async () => {
    const buyer = await newUser({ name: 'Anna Koval' });
    const product = await createProduct({ price: 10, stock: 5 });
    products.push(product);
    const order = await flows.shippedOrder(buyer, product, 1);
    const returnId = await flows.formStatement(order.orderId, true, `form-${buyer.id}@example.com`);

    const [statement] = returnsOf((await exportOf(accessCookie(buyer))).json(), order.orderId);

    expect(statement).toMatchObject({
      id: returnId,
      source: 'form_code',
      contact: { name: 'Anna Koval', email: `form-${buyer.id}@example.com` },
    });
  });
});

// a form without a code can come from anybody who knows the number and the name of the recipient:
// what its sender wrote is the person's only when the shop took it for theirs
describe('a statement of the form without a code in the export', () => {
  const personal = { contact: null, ip: null, userAgent: null, description: null };

  async function manualStatement(email: (buyer: TestUser) => string) {
    const buyer = await newUser({ name: 'Anna Koval' });
    const product = await createProduct({ price: 10, stock: 5 });
    products.push(product);
    const order = await flows.shippedOrder(buyer, product, 1);
    const returnId = await flows.formStatement(order.orderId, false, email(buyer));
    return { buyer, orderId: order.orderId, returnId };
  }

  const exportedOf = async (buyer: TestUser, orderId: number) =>
    returnsOf((await exportOf(accessCookie(buyer))).json(), orderId)[0]!;

  it('leaves out what the sender wrote while the shop has not taken it for the buyer', async () => {
    const { buyer, orderId, returnId } = await manualStatement(() => 'someone@example.com');

    const statement = await exportedOf(buyer, orderId);

    expect(statement).toMatchObject({ id: returnId, source: 'form_manual', ...personal });
    expect(JSON.stringify(statement)).not.toContain('someone@example.com');
  });

  it('gives what the sender wrote when its email is the one of the account', async () => {
    const { buyer, orderId } = await manualStatement((who) => who.email);

    const statement = await exportedOf(buyer, orderId);

    expect(statement).toMatchObject({
      source: 'form_manual',
      contact: { name: 'Anna Koval', email: buyer.email },
      ip: expect.any(String),
    });
  });

  it('never gives it when root closed it as not of the buyer', async () => {
    const { buyer, orderId, returnId } = await manualStatement((who) => who.email);
    const closed = await app.inject({
      method: 'POST',
      url: `/api/returns/${returnId}/close`,
      headers: withCsrf(csrf, accessCookie(root)),
      payload: { code: 'not_buyer', note: 'Somebody else.' },
    });
    expect(closed.statusCode).toBe(200);

    const statement = await exportedOf(buyer, orderId);

    expect(statement).toMatchObject({ source: 'form_manual', ...personal });
  });
});

describe('the words of the admins in the export', () => {
  it('leaves out the description an admin wrote on a statement of the shop', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 5 });
    products.push(product);
    const order = await flows.shippedOrder(buyer, product, 1);
    await flows.adminStatement(order.orderId, order.itemId, 1, {
      description: 'Called in, the buyer is upset.',
    });

    const statement = returnsOf((await exportOf(accessCookie(buyer))).json(), order.orderId)[0]!;

    expect(statement).toMatchObject({ source: 'admin', description: null });
    expect(JSON.stringify(statement)).not.toContain('Called in');
  });
});

describe('GET /api/users/:userId/export', () => {
  it('gives root the same set as the person gets, as a file named after the person', async () => {
    const { buyer, orderId } = await buyerWithStatement();

    const own = (await exportOf(accessCookie(buyer))).json();
    const res = await exportOfUser(buyer.id, accessCookie(root));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="cartlify-data-${buyer.id}.json"`,
    );
    const given = res.json();
    expect(given.profile).toMatchObject({ id: buyer.id, email: buyer.email });
    expect(returnsOf(given, orderId)).toEqual(returnsOf(own, orderId));
    expect(given.orders).toEqual(own.orders);
  });

  it('leaves a line in the admin log under the name of root', async () => {
    const buyer = await newUser();
    const before = await asAdmin((tx) =>
      tx.adminAuditLog.count({ where: { entityType: 'user', entityId: buyer.id } }),
    );

    expect((await exportOfUser(buyer.id, accessCookie(root))).statusCode).toBe(200);

    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'user', entityId: buyer.id },
        orderBy: { id: 'asc' },
        select: { action: true, event: true, actorId: true },
      }),
    );
    expect(lines).toHaveLength(before + 1);
    expect(lines.at(-1)).toEqual({ action: 'OTHER', event: 'user.export', actorId: root.id });
  });

  // the route of root is always on the record, also when the id is root's own
  it('leaves a line when root asks for their own data by the route of root', async () => {
    const before = await asAdmin((tx) =>
      tx.adminAuditLog.count({
        where: { entityType: 'user', entityId: root.id, event: 'user.export' },
      }),
    );

    expect((await exportOfUser(root.id, accessCookie(root))).statusCode).toBe(200);

    expect(
      await asAdmin((tx) =>
        tx.adminAuditLog.count({
          where: { entityType: 'user', entityId: root.id, event: 'user.export' },
        }),
      ),
    ).toBe(before + 1);
  });

  it('writes no line for the person exporting their own data', async () => {
    const buyer = await newUser();

    expect((await exportOf(accessCookie(buyer))).statusCode).toBe(200);

    expect(
      await asAdmin((tx) =>
        tx.adminAuditLog.count({ where: { entityType: 'user', entityId: buyer.id } }),
      ),
    ).toBe(0);
  });

  // a request that came by mail after the account was deleted: what is still kept of the person
  it('gives the data of a deleted account that is still kept: the orders and their statements', async () => {
    const { buyer, orderId, returnId } = await buyerWithStatement();
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/users/${buyer.id}`,
      headers: withCsrf(csrf, accessCookie(root)),
    });
    expect(deleted.statusCode).toBe(200);

    const res = await exportOfUser(buyer.id, accessCookie(root));

    expect(res.statusCode).toBe(200);
    const given = res.json();
    expect(given.profile.email).not.toBe(buyer.email);
    const [statement] = returnsOf(given, orderId);
    expect(statement).toMatchObject({
      id: returnId,
      contact: { name: 'Anna Koval', email: buyer.email },
    });
  });

  it.each(['USER', 'ADMIN'] as const)('refuses a %s', async (role) => {
    const actor = await newUser({ role });
    const target = await newUser();

    const res = await exportOfUser(target.id, accessCookie(actor));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('refuses a visitor who is not signed in', async () => {
    const target = await newUser();

    const res = await exportOfUser(target.id, '');

    // a visitor without a login is a guest
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('answers 404 for a user that does not exist', async () => {
    const res = await exportOfUser(2_000_000_000, accessCookie(root));

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
  });

  it.each(['0', '-1', 'abc', '2147483648'])('refuses the id %s', async (id) => {
    const res = await exportOfUser(id, accessCookie(root));

    expect(res.statusCode).toBe(400);
  });
});

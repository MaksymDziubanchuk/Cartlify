import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { shopSettings } from '@config/shopSettings.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  stockLogOf,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { placeOrderOf } from '../../../helpers/orders.js';
import { placePaidOrder } from '../../../helpers/payments.js';
import { whileLocked } from '../../../helpers/variants.js';

// the statements of withdrawal and of return an admin makes and settles: POST /api/returns makes a
// statement for the items of a paid, shipped or delivered order, GET reads it, the goods of its rows
// are taken in with POST /api/returns/:returnId/receive and the proof of the buyer is confirmed with
// POST /api/returns/:returnId/proof/confirm. The buyer is mailed that the shop registered a return,
// each step goes to the admin log, and the order says where it stands (returnStatus)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
let stranger: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  buyer = await createUser({ name: 'Anna Koval' });
  stranger = await createUser();
  userIds.push(admin.id, root.id, buyer.id, stranger.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct({ price: 10, stock: 20, ...opts });
  products.push(product);
  return product;
};

const post = (url: string, payload: Record<string, unknown> = {}, actor: TestUser | null = admin) =>
  app.inject({
    method: 'POST',
    url,
    headers: actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf),
    payload,
  });

const get = (url: string, actor: TestUser | null = admin) =>
  app.inject({
    method: 'GET',
    url,
    ...(actor ? { headers: { cookie: accessCookie(actor) } } : {}),
  });

// a paid order of the buyer with the units asked of the product, and the ids of its items
async function paidOrder(units: number, product?: TestProduct, owner: TestUser = buyer) {
  const item = product ?? (await newProduct());
  const orderId = await placeOrderOf(app, csrf, owner, [{ item, quantity: units }], 'paid');
  const orderItems = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
  );
  return { orderId, itemId: orderItems[0]!.id, product: item };
}

const make = (
  orderId: number,
  items: Array<{ orderItemId: number; quantity: number }>,
  extra = {},
) =>
  post('/api/returns', {
    orderId,
    items,
    basis: 'other',
    reason: 'defect',
    description: 'The box came open.',
    ...extra,
  });

const orderOf = async (orderId: number, actor: TestUser = admin) =>
  (await get(`/api/orders/${orderId}`, actor)).json();

describe('POST /api/returns', () => {
  it('makes the statement of an admin for the items of a paid order and answers with its card', async () => {
    const { orderId, itemId, product } = await paidOrder(3);

    const res = await make(orderId, [{ orderItemId: itemId, quantity: 2 }]);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(Number),
      // the first statement of the order, outside the withdrawal
      code: `R${orderId}-1`,
      orderId,
      extendsId: null,
      splitFromId: null,
      splitIds: [],
      statedAt: expect.any(String),
      source: 'admin',
      basis: 'other',
      reason: 'defect',
      description: 'The box came open.',
      contact: { name: 'Anna Koval', email: buyer.email },
      createdBy: { id: admin.id, name: null, email: admin.email },
      ip: expect.anything(),
      userAgent: expect.anything(),
      acceptedAt: null,
      acceptedBy: null,
      closedAt: null,
      closedBy: null,
      closeCode: null,
      closeNote: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      order: {
        id: orderId,
        status: 'paid',
        returnStatus: 'open',
        buyer: { id: buyer.id, name: 'Anna Koval', email: buyer.email, deleted: false },
        recipient: expect.objectContaining({ firstName: 'Anna', lastName: 'Koval' }),
      },
      // the answer is the card after the step: its history ends with the line of it
      history: [
        expect.objectContaining({
          event: 'return.create',
          actorRole: 'ADMIN',
          actor: { id: admin.id, name: null, email: admin.email },
        }),
      ],
      parcels: [],
      // outside the withdrawal nothing is taken off, and no parcel of the shop to warn of
      deductible: 0,
      warnings: [],
      // no money moved yet: nothing went back, nothing blocks a transfer
      refundedTotal: 0,
      disputeOpen: false,
      handRefundPending: false,
      bankMoneyPending: false,
      // two units at 10 owed, none due yet (the goods are on their way), 30 left of the payment
      moneyLeft: {
        rows: 20,
        delivery: 0,
        wayBack: 0,
        total: 20,
        due: 0,
        covered: 0,
        paymentLeft: 30,
        short: false,
      },
      moneyOverpaid: 0,
      money: [],
      items: [
        {
          id: expect.any(Number),
          orderItemId: itemId,
          productId: product.id,
          variantId: product.variantId,
          name: expect.any(String),
          quantity: 2,
          goods: 'expected',
          notAcceptedReason: null,
          money: 'not_refunded',
          amount: 20,
          paid: 0,
          amountNote: null,
          goodsSetAt: null,
          goodsSetBy: null,
          moneyLogId: null,
          refundFailure: null,
          refusedCode: null,
        },
      ],
    });
  });

  it('writes the admin log and mails the buyer that the shop registered a return', async () => {
    const { orderId, itemId } = await paidOrder(2);
    const mails = watchMail();

    const res = await make(orderId, [{ orderItemId: itemId, quantity: 1 }], { reason: 'damaged' });
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.create' },
        select: { actorId: true, action: true, meta: true },
      }),
    );

    expect(res.statusCode).toBe(201);
    expect(lines).toEqual([
      expect.objectContaining({
        actorId: admin.id,
        action: 'OTHER',
        meta: expect.arrayContaining([
          { field: 'returnId', old: null, new: res.json().id },
          { field: 'basis', old: null, new: 'other' },
          { field: 'reason', old: null, new: 'damaged' },
        ]),
      }),
    ]);
    const own = mails.filter((mail) => mail.to.includes(buyer.email));
    expect(own).toHaveLength(1);
    expect(own[0]!.subject).toContain(`Return of order #${orderId}`);
    expect(own[0]!.text).toContain('damage');
    // a neutral line with where to write
    expect(own[0]!.text).toContain(shopSettings().emailReplyTo);
  });

  // the language of the buyer's account (mailLocaleOf), not the shop's
  it("mails the return in the language of the buyer's account", async () => {
    const owner = await createUser({ name: 'Ana', locale: 'es' });
    userIds.push(owner.id);
    const { orderId, itemId } = await paidOrder(2, undefined, owner);
    const mails = watchMail();

    const res = await make(orderId, [{ orderItemId: itemId, quantity: 1 }], { reason: 'damaged' });

    expect(res.statusCode).toBe(201);
    const own = mails.filter((mail) => mail.to.includes(owner.email));
    expect(own).toHaveLength(1);
    expect(own[0]!.subject).toContain(`Se registró la devolución del pedido #${orderId}`);
    expect(own[0]!.text).toContain('Hola, Ana:');
  });

  it('is dated by the admin when they give a moment of the past, and by the server otherwise', async () => {
    const { orderId, itemId } = await paidOrder(2);
    // the first moment there can be one: the time the order was paid
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );
    const paid = paidAt!.toISOString();

    const past = await make(orderId, [{ orderItemId: itemId, quantity: 1 }], {
      basis: 'withdrawal',
      reason: 'goodwill',
      statedAt: paid,
    });
    const now = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);

    expect(past.statusCode).toBe(201);
    expect(past.json().statedAt).toBe(paid);
    expect(Math.abs(Date.now() - new Date(now.json().statedAt).getTime())).toBeLessThan(120_000);
  });

  it('makes an extension that points at the statement it extends', async () => {
    const { orderId, itemId } = await paidOrder(3);
    const first = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);

    const second = await make(orderId, [{ orderItemId: itemId, quantity: 2 }], {
      extendsId: first.json().id,
    });

    expect(second.statusCode).toBe(201);
    expect(second.json().extendsId).toBe(first.json().id);
  });

  it('shows the state of the order to the admin and to the buyer, and lists the statements for the admin', async () => {
    const { orderId, itemId } = await paidOrder(2);
    const before = await orderOf(orderId);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);

    const forAdmin = await orderOf(orderId);
    const forBuyer = await orderOf(orderId, buyer);

    expect(before).toMatchObject({ returnStatus: 'none', returns: [] });
    expect(forAdmin.returnStatus).toBe('open');
    expect(forAdmin.returns).toEqual([
      {
        id: made.json().id,
        code: made.json().code,
        statedAt: made.json().statedAt,
        source: 'admin',
        basis: 'other',
        reason: 'defect',
        extendsId: null,
        closedAt: null,
      },
    ]);
    expect(forBuyer.returnStatus).toBe('open');
    expect(forBuyer).not.toHaveProperty('returns');
  });

  it.each([
    [
      'an order that is not there',
      (ctx: Ctx) => ({ orderId: 2_000_000_000, items: ctx.items(1) }),
      404,
      'RETURN_ORDER_NOT_FOUND',
    ],
    [
      'more units than were bought',
      (ctx: Ctx) => ({ orderId: ctx.orderId, items: ctx.items(9) }),
      409,
      'RETURN_QUANTITY_EXCEEDED',
    ],
    [
      'an item of the order that is not there',
      (ctx: Ctx) => ({
        orderId: ctx.orderId,
        items: [{ orderItemId: 2_000_000_000, quantity: 1 }],
      }),
      404,
      'RETURN_ITEM_NOT_FOUND',
    ],
    [
      'an item named twice',
      (ctx: Ctx) => ({ orderId: ctx.orderId, items: [...ctx.items(1), ...ctx.items(1)] }),
      400,
      'RETURN_ITEMS_REPEATED',
    ],
    [
      'a moment of the future',
      (ctx: Ctx) => ({
        orderId: ctx.orderId,
        items: ctx.items(1),
        statedAt: '2999-01-01T00:00:00.000Z',
      }),
      400,
      'RETURN_STATED_AT_INVALID',
    ],
    [
      'a moment before the order was paid',
      (ctx: Ctx) => ({
        orderId: ctx.orderId,
        items: ctx.items(1),
        statedAt: '2026-01-02T10:00:00.000Z',
      }),
      400,
      'RETURN_STATED_AT_INVALID',
    ],
    [
      'an extension of a statement that is not there',
      (ctx: Ctx) => ({ orderId: ctx.orderId, items: ctx.items(1), extendsId: 2_000_000_000 }),
      400,
      'RETURN_EXTENDS_INVALID',
    ],
  ])('refuses %s (%s)', async (_what, body, status, code) => {
    const { orderId, itemId } = await paidOrder(2);
    const ctx: Ctx = { orderId, items: (quantity) => [{ orderItemId: itemId, quantity }] };

    const res = await post('/api/returns', { basis: 'other', reason: 'defect', ...body(ctx) });

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({ status, code });
  });

  it.each([
    ['no items', { items: [] }],
    ['no reason for a statement outside the withdrawal', { reason: undefined }],
    ['a basis there is not', { basis: 'maybe' }],
    ['a reason there is not', { reason: 'whim' }],
    ['units that are not whole', { items: [{ orderItemId: 1, quantity: 1.5 }] }],
    ['a description over 2000 characters', { description: 'a'.repeat(2001) }],
  ])('refuses %s (VALIDATION_ERROR)', async (_what, patch) => {
    const { orderId, itemId } = await paidOrder(1);

    const res = await post('/api/returns', {
      orderId,
      items: [{ orderItemId: itemId, quantity: 1 }],
      basis: 'other',
      reason: 'defect',
      ...patch,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: expect.stringMatching(/VALIDATION_ERROR|RETURN_/),
    });
  });

  it('refuses an order that is not paid (RETURN_ORDER_NOT_RETURNABLE)', async () => {
    const item = await newProduct();
    const orderId = await placeOrderOf(app, csrf, buyer, [{ item }], 'waiting');
    const [orderItem] = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
    );

    const res = await make(orderId, [{ orderItemId: orderItem!.id, quantity: 1 }]);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_ORDER_NOT_RETURNABLE' });
  });

  it('refuses a statement of withdrawal for an item that has no right of withdrawal', async () => {
    const { orderId, itemId } = await paidOrder(1, await newProduct({ withdrawal: 'perishable' }));

    const refused = await make(orderId, [{ orderItemId: itemId, quantity: 1 }], {
      basis: 'withdrawal',
      reason: 'goodwill',
    });
    const outside = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ errorCode: 'RETURN_ITEM_NOT_RETURNABLE' });
    expect(outside.statusCode).toBe(201);
  });

  it('is for an admin or a root: a buyer and a visitor are refused', async () => {
    const { orderId, itemId } = await paidOrder(1);
    const body = {
      orderId,
      items: [{ orderItemId: itemId, quantity: 1 }],
      basis: 'other',
      reason: 'defect',
    };

    const byBuyer = await post('/api/returns', body, buyer);
    const byGuest = await post('/api/returns', body, null);

    expect(byBuyer.statusCode).toBe(403);
    expect(byBuyer.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    // a visitor without a login is a guest, and no admin
    expect(byGuest.statusCode).toBe(403);
    expect(byGuest.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

type Ctx = {
  orderId: number;
  items: (quantity: number) => Array<{ orderItemId: number; quantity: number }>;
};

describe('GET /api/returns/:returnId', () => {
  it('gives the card of the statement to an admin, with the order and its rows', async () => {
    const { orderId, itemId } = await paidOrder(2);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 2 }]);

    const res = await get(`/api/returns/${made.json().id}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(made.json());
  });

  // everything the shop knows of a statement, in one place (6.2)
  it('gives the account of the order, its recipient and what was done with the statement', async () => {
    const { orderId, itemId } = await paidOrder(1);
    const made = (await make(orderId, [{ orderItemId: itemId, quantity: 1 }])).json();
    await post(`/api/returns/${made.id}/proof/confirm`, { buyerPaid: 0 });

    const card = (await get(`/api/returns/${made.id}`)).json();

    expect(card.order).toMatchObject({
      id: orderId,
      buyer: { id: buyer.id, name: 'Anna Koval', email: buyer.email, deleted: false },
      recipient: expect.objectContaining({
        method: 'manual',
        firstName: 'Anna',
        lastName: 'Koval',
        phone: '+380501234567',
      }),
    });
    expect(card.history.map((line: { event: string }) => line.event)).toEqual([
      'return.create',
      'return.proof_confirm',
    ]);
    expect(card.history[0]).toMatchObject({
      actorRole: 'ADMIN',
      actor: { id: admin.id, name: null, email: admin.email },
      changes: expect.arrayContaining([{ field: 'returnId', old: null, new: made.id }]),
    });
  });

  // root is hidden from the admins, as the journals hide it
  it('hides root from an admin and shows it to root', async () => {
    const { orderId, itemId } = await paidOrder(1);
    const made = (await make(orderId, [{ orderItemId: itemId, quantity: 1 }])).json();
    const closed = await post(
      `/api/returns/${made.id}/close`,
      { code: 'buyer_changed_mind', note: 'Kept it.' },
      root,
    );
    expect(closed.statusCode).toBe(200);

    const seen = (await get(`/api/returns/${made.id}`)).json();
    const own = (await get(`/api/returns/${made.id}`, root)).json();

    // root has no name here: a name would be hidden too
    const hidden = { id: 0, name: null, email: 'hidden' };
    expect(seen.closedBy).toEqual(hidden);
    expect(seen.history.at(-1)).toMatchObject({ event: 'return.close', actor: hidden });
    expect(JSON.stringify(seen)).not.toContain(root.email);
    expect(own.closedBy).toMatchObject({ id: root.id, email: root.email });
  });

  it('is refused to a buyer and to a visitor (403), and not found for an id that is not there (404)', async () => {
    const { orderId, itemId } = await paidOrder(1);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);

    const byBuyer = await get(`/api/returns/${made.json().id}`, buyer);
    const byGuest = await get(`/api/returns/${made.json().id}`, null);
    const missing = await get('/api/returns/2000000000');

    expect(byBuyer.statusCode).toBe(403);
    expect(byGuest.statusCode).toBe(403);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ errorCode: 'RETURN_NOT_FOUND' });
  });
});

describe('POST /api/returns/:returnId/receive', () => {
  const receive = (returnId: number, results: unknown, actor: TestUser | null = admin) =>
    post(`/api/returns/${returnId}/receive`, { results, parcel: { buyerPaid: 0 } }, actor);

  it('puts the units back into the stock and the batches, splits the row, and writes the admin log and the stock log', async () => {
    const { orderId, itemId, product } = await paidOrder(3);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 3 }]);
    const before = await stockOf(product);

    const res = await receive(made.json().id, [
      { itemId: made.json().items[0].id, quantity: 2, goods: 'to_stock' },
    ]);

    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .items.map((row: { goods: string; quantity: number; amount: number }) => [
          row.goods,
          row.quantity,
          row.amount,
        ]),
    ).toEqual([
      ['expected', 1, 10],
      ['to_stock', 2, 20],
    ]);
    expect(res.json().items[1]).toMatchObject({
      goodsSetBy: { id: admin.id },
      goodsSetAt: expect.any(String),
    });
    expect((await stockOf(product)).stock).toBe(before.stock + 2);
    expect(
      (await stockLogOf({ orderId })).filter((line) => line.event === 'stock.return'),
    ).toHaveLength(1);
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.receive' },
        select: { actorId: true, meta: true },
      }),
    );
    expect(lines).toEqual([
      expect.objectContaining({
        actorId: admin.id,
        meta: expect.arrayContaining([{ field: 'returnId', old: null, new: made.json().id }]),
      }),
    ]);
  });

  it('closes the statement of goods that were not accepted and says declined for the order', async () => {
    const { orderId, itemId } = await paidOrder(1);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);

    const res = await receive(made.json().id, [
      {
        itemId: made.json().items[0].id,
        quantity: 1,
        goods: 'not_accepted',
        notAcceptedReason: 'unsealed',
      },
    ]);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      closedAt: expect.any(String),
      closedBy: { id: admin.id },
      order: { returnStatus: 'declined' },
      items: [{ goods: 'not_accepted', notAcceptedReason: 'unsealed', money: 'refused' }],
    });
    expect((await orderOf(orderId, buyer)).returnStatus).toBe('declined');
  });

  it('takes units as lost only with the parcel confirmed (RETURN_PARCEL_REQUIRED, then ok)', async () => {
    const { orderId, itemId } = await paidOrder(1);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);
    const result = [{ itemId: made.json().items[0].id, quantity: 1, goods: 'lost' }];

    const without = await post(`/api/returns/${made.json().id}/receive`, { results: result });
    await post(`/api/returns/${made.json().id}/proof/confirm`, { buyerPaid: 0 });
    const confirmed = await post(`/api/returns/${made.json().id}/receive`, { results: result });

    expect(without.statusCode).toBe(409);
    expect(without.json()).toMatchObject({ errorCode: 'RETURN_PARCEL_REQUIRED' });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().items[0]).toMatchObject({ goods: 'lost' });
  });

  it.each([
    [
      'a row that is not there',
      (row: Row) => ({ itemId: row.id + 1_000_000, quantity: 1, goods: 'to_stock' }),
      404,
      'RETURN_ITEM_NOT_FOUND',
    ],
    [
      'more units than the row holds',
      (row: Row) => ({ itemId: row.id, quantity: 5, goods: 'to_stock' }),
      409,
      'RETURN_QUANTITY_EXCEEDED',
    ],
    [
      'a refusal to accept without its reason',
      (row: Row) => ({ itemId: row.id, quantity: 1, goods: 'not_accepted' }),
      400,
      'RETURN_NOT_ACCEPTED_REASON_REQUIRED',
    ],
  ])('refuses %s (%s)', async (_what, result, status, code) => {
    const { orderId, itemId } = await paidOrder(2);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 2 }]);

    const res = await receive(made.json().id, [result(made.json().items[0])]);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({ status, code });
  });

  it('refuses a row that has a result already (RETURN_ITEM_NOT_EXPECTED)', async () => {
    // the order is bigger than the statement: an order with every unit back is cancelled, and a
    // statement of a cancelled order takes nothing in (RETURN_ORDER_NOT_RETURNABLE)
    const { orderId, itemId } = await paidOrder(2);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);
    const result = [{ itemId: made.json().items[0].id, quantity: 1, goods: 'to_stock' }];
    await receive(made.json().id, result);

    const again = await receive(made.json().id, result);

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'RETURN_ITEM_NOT_EXPECTED' });
  });

  it.each([
    ['no results', []],
    ['a result with no goods', [{ itemId: 1, quantity: 1 }]],
    ['goods there are not', [{ itemId: 1, quantity: 1, goods: 'expected' }]],
  ])('refuses %s (400)', async (_what, results) => {
    const { orderId, itemId } = await paidOrder(1);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);

    const res = await receive(made.json().id, results);

    expect(res.statusCode).toBe(400);
  });

  it('is for an admin: a buyer is refused (403), a statement that is not there is 404', async () => {
    const { orderId, itemId } = await paidOrder(1);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);
    const results = [{ itemId: made.json().items[0].id, quantity: 1, goods: 'to_stock' }];

    const byBuyer = await receive(made.json().id, results, buyer);
    const missing = await receive(2_000_000_000, results);

    expect(byBuyer.statusCode).toBe(403);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ errorCode: 'RETURN_NOT_FOUND' });
  });
});

type Row = { id: number };

describe('a cancel of the order and the statements', () => {
  // the cancel of a paid order is a statement like the others, with the reason shop_cancel
  const cancelOf = (orderId: number, items: Array<{ orderItemId: number; quantity: number }>) =>
    post('/api/returns', { orderId, items, basis: 'other', reason: 'shop_cancel' });

  // an order paid by a card, as the cancel refunds it; the item of it
  async function paidByCard(units: number) {
    const product = await newProduct();
    const { orderId } = await placePaidOrder(app, csrf, buyer, product, { quantity: units });
    const items = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
    );
    return { orderId, itemId: items[0]!.id, product };
  }

  it('gives back only the units not stated yet: the cancel of the rest is a second statement', async () => {
    const product = await newProduct();
    const initial = (await stockOf(product)).stock;
    const { orderId } = await placePaidOrder(app, csrf, buyer, product, { quantity: 3 });
    const [item] = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
    );
    const made = await make(orderId, [{ orderItemId: item!.id, quantity: 2 }]);
    await post(`/api/returns/${made.json().id}/receive`, {
      parcel: { buyerPaid: 0 },
      results: [{ itemId: made.json().items[0].id, quantity: 2, goods: 'to_stock' }],
    });

    // the cancel of all 3 units takes the 2 that came back again: refused, nothing moves
    const tooMany = await cancelOf(orderId, [{ orderItemId: item!.id, quantity: 3 }]);
    const res = await cancelOf(orderId, [{ orderItemId: item!.id, quantity: 1 }]);

    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json()).toMatchObject({ errorCode: 'RETURN_QUANTITY_EXCEEDED' });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).not.toBe(made.json().id);
    expect(res.json().order.status).toBe('cancelled');
    // 3 sold, 2 came back by the statement, the cancel gives back the third: all 3 are on the shelf
    expect((await stockOf(product)).stock).toBe(initial);
    expect(
      (await stockLogOf({ orderId }))
        .filter((line) => line.event === 'stock.return')
        .map((line) => line.quantityChange),
    ).toEqual([2, 1]);
  });

  // the cancel puts back every unit of the order that is not back yet, so a row that waits for its
  // goods cannot be on a cancelled order. What can be left on one is a statement whose rows root
  // closed without goods before the cancel (their units are free to be cancelled): taking units in
  // on it is refused, as the order is cancelled
  it('refuses to take units in on an order that is cancelled (409 RETURN_ORDER_NOT_RETURNABLE)', async () => {
    const { orderId, itemId } = await paidByCard(2);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 2 }]);
    const closed = await post(
      `/api/returns/${made.json().id}/close`,
      { code: 'not_buyer', note: 'Not the buyer.' },
      root,
    );
    const cancelled = await cancelOf(orderId, [{ orderItemId: itemId, quantity: 2 }]);
    expect(closed.statusCode).toBe(200);
    expect(cancelled.statusCode).toBe(201);
    expect(cancelled.json().order.status).toBe('cancelled');

    const res = await post(`/api/returns/${made.json().id}/receive`, {
      parcel: { buyerPaid: 0 },
      results: [{ itemId: made.json().items[0].id, quantity: 2, goods: 'to_stock' }],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_ORDER_NOT_RETURNABLE' });
  });
});

describe('two requests at once', () => {
  const lockOrder = async (tx: Prisma.TransactionClient, orderId: number) => {
    await tx.$queryRaw`select id from cartlify.orders where id = ${orderId}::int for update`;
  };
  const lockReturn = async (tx: Prisma.TransactionClient, returnId: number) => {
    await tx.$queryRaw`select id from cartlify.returns where id = ${returnId}::int for update`;
  };

  it('lets only one statement take the last unit of an item (409 RETURN_QUANTITY_EXCEEDED for the other)', async () => {
    const { orderId, itemId } = await paidOrder(1);

    const results = await whileLocked(
      (tx) => lockOrder(tx, orderId),
      () =>
        Promise.all([
          make(orderId, [{ orderItemId: itemId, quantity: 1 }]),
          make(orderId, [{ orderItemId: itemId, quantity: 1 }]),
        ]),
      { waiters: 2 },
    );

    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((res) => res.statusCode === 409)!.json()).toMatchObject({
      errorCode: 'RETURN_QUANTITY_EXCEEDED',
    });
    expect(await asAdmin((tx) => tx.orderReturn.count({ where: { orderId } }))).toBe(1);
  });

  it('takes the units of a row in once (409 RETURN_ITEM_NOT_EXPECTED for the other)', async () => {
    // one unit of the order is not in the statement, so the order is not cancelled by the first take
    const { orderId, itemId, product } = await paidOrder(3);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 2 }]);
    const before = await stockOf(product);
    const take = () =>
      post(`/api/returns/${made.json().id}/receive`, {
        parcel: { buyerPaid: 0 },
        results: [{ itemId: made.json().items[0].id, quantity: 2, goods: 'to_stock' }],
      });

    const results = await whileLocked(
      (tx) => lockReturn(tx, made.json().id),
      () => Promise.all([take(), take()]),
      { waiters: 2 },
    );

    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((res) => res.statusCode === 409)!.json()).toMatchObject({
      errorCode: 'RETURN_ITEM_NOT_EXPECTED',
    });
    // the units went back once
    expect((await stockOf(product)).stock).toBe(before.stock + 2);
  });
});

describe('POST /api/returns/:returnId/proof/confirm', () => {
  it('records who confirmed the proof and when, in the card and in the admin log', async () => {
    const { orderId, itemId } = await paidOrder(1);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);

    const res = await post(`/api/returns/${made.json().id}/proof/confirm`, { buyerPaid: 0 });

    expect(res.statusCode).toBe(200);
    // an admin confirms the proof from a letter too: the parcel to the shop is written without a
    // carrier, recorded and confirmed by the admin
    expect(res.json().parcels).toEqual([
      expect.objectContaining({
        direction: 'to_shop',
        carrier: null,
        recordedBy: expect.objectContaining({ id: admin.id }),
        confirmedAt: expect.any(String),
        confirmedBy: expect.objectContaining({ id: admin.id }),
      }),
    ]);
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.proof_confirm' },
        select: { actorId: true },
      }),
    );
    expect(lines).toEqual([{ actorId: admin.id }]);
  });

  it('is done once (409), by an admin only (403), for a statement that is there (404)', async () => {
    const { orderId, itemId } = await paidOrder(1);
    const made = await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);
    const url = `/api/returns/${made.json().id}/proof/confirm`;

    const byBuyer = await post(url, { buyerPaid: 0 }, buyer);
    await post(url, { buyerPaid: 0 });
    const again = await post(url, { buyerPaid: 0 });
    const missing = await post('/api/returns/2000000000/proof/confirm', { buyerPaid: 0 });

    expect(byBuyer.statusCode).toBe(403);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'RETURN_PROOF_ALREADY_CONFIRMED' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('the answers of an order and the statements', () => {
  it('leaves a stranger without the order (404): a statement of another order is no business of theirs', async () => {
    const { orderId, itemId } = await paidOrder(1);
    await make(orderId, [{ orderItemId: itemId, quantity: 1 }]);

    const res = await get(`/api/orders/${orderId}`, stranger);

    expect(res.statusCode).toBe(404);
  });
});

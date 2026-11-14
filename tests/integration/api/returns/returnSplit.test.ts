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
import { watchMail } from '../../../helpers/mail.js';
import { placeOrderOf } from '../../../helpers/orders.js';

// a statement splits when its goods come back in more than one parcel: POST
// /api/returns/:returnId/split takes the units an admin names into a new statement of the order. The
// answer is the card of the new statement, the first names it, the buyer is mailed its code and the
// admin log keeps the step. The rules of the rows are the database's (db/returnSplit.test.ts); here
// the body, the answers, the mail and the log

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(admin.id, buyer.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const post = (url: string, payload: Record<string, unknown>, actor: TestUser = admin) =>
  app.inject({ method: 'POST', url, headers: withCsrf(csrf, accessCookie(actor)), payload });

const cardOf = async (returnId: number) =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/returns/${returnId}`,
      headers: { cookie: accessCookie(admin) },
    })
  ).json();

// a sent order of three units of the buyer and the statement of an admin for them; the ids
async function statement() {
  const product = await createProduct({ price: 10, stock: 20 });
  products.push(product);
  const orderId = await placeOrderOf(app, csrf, buyer, [{ item: product, quantity: 3 }], 'shipped');
  const [item] = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, select: { id: true, productName: true } }),
  );
  const made = await post('/api/returns', {
    orderId,
    items: [{ orderItemId: item!.id, quantity: 3 }],
    basis: 'other',
    reason: 'defect',
  });
  expect(made.statusCode).toBe(201);
  return {
    orderId,
    returnId: made.json().id as number,
    code: made.json().code as string,
    rowId: made.json().items[0].id as number,
    productName: item!.productName,
  };
}

describe('POST /api/returns/:returnId/split', () => {
  it('takes the units named into a new statement: its card, the first names it, the buyer is mailed its code', async () => {
    const { orderId, returnId, code, rowId, productName } = await statement();
    const mails = watchMail();

    const res = await post(`/api/returns/${returnId}/split`, {
      items: [{ itemId: rowId, quantity: 1 }],
    });

    expect(res.statusCode).toBe(201);
    const second = res.json();
    expect(second).toMatchObject({
      orderId,
      code: `R${orderId}-2`,
      splitFromId: returnId,
      items: [expect.objectContaining({ quantity: 1, goods: 'expected' })],
    });
    expect(await cardOf(returnId)).toMatchObject({
      splitFromId: null,
      splitIds: [second.id],
      items: [expect.objectContaining({ id: rowId, quantity: 2 })],
    });

    const own = mails.filter(
      (mail) =>
        mail.to.includes(buyer.email) &&
        mail.subject.includes(`A statement of its own for goods of order #${orderId}`),
    );
    expect(own).toHaveLength(1);
    expect(own[0]!.subject.endsWith(`(R${orderId}-2)`)).toBe(true);
    expect(own[0]!.text).toContain(`not in the parcel of statement ${code}`);
    expect(own[0]!.text).toContain(`- ${productName} x 1`);
  });

  it('keeps the step in the admin log with both statements and the rows that left', async () => {
    const { orderId, returnId, rowId } = await statement();

    const res = await post(`/api/returns/${returnId}/split`, {
      items: [{ itemId: rowId, quantity: 2 }],
    });

    expect(res.statusCode).toBe(201);
    const second = res.json();
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.split' },
        select: { meta: true },
      }),
    );
    expect(lines).toEqual([
      {
        meta: [
          { field: 'returnId', old: null, new: returnId },
          { field: 'splitId', old: null, new: second.id },
          { field: 'itemIds', old: null, new: [second.items[0].id] },
        ],
      },
    ]);
  });

  it('refuses no rows (400), a split that leaves the statement nothing (409 RETURN_SPLIT_INVALID) and a row of another statement (404)', async () => {
    const { returnId, rowId } = await statement();
    const other = await statement();

    const none = await post(`/api/returns/${returnId}/split`, { items: [] });
    const whole = await post(`/api/returns/${returnId}/split`, {
      items: [{ itemId: rowId, quantity: 3 }],
    });
    const foreign = await post(`/api/returns/${returnId}/split`, {
      items: [{ itemId: other.rowId, quantity: 1 }],
    });

    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(whole.statusCode).toBe(409);
    expect(whole.json()).toMatchObject({ errorCode: 'RETURN_SPLIT_INVALID' });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ errorCode: 'RETURN_ITEM_NOT_FOUND' });
  });

  it('is an admin route (403 for the buyer)', async () => {
    const { returnId, rowId } = await statement();

    const res = await post(
      `/api/returns/${returnId}/split`,
      { items: [{ itemId: rowId, quantity: 1 }] },
      buyer,
    );

    expect(res.statusCode).toBe(403);
  });
});

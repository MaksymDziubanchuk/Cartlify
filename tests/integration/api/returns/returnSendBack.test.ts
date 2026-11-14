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

// the goods the shop did not accept go back to the buyer: POST /api/returns/:returnId/shipments with
// the direction to_buyer and the rows and units the parcel carries. The card lists the parcel with
// its rows, the buyer sees it on the order and is mailed its carrier and number, and the admin log
// keeps the step. The rules of the rows are the database's (db/returnSendBack.test.ts); here the
// body, the answers, the mail and the log

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

const get = (url: string, actor: TestUser) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

// a sent order of three units of the buyer, the statement of an admin for them, and the units taken
// in as not accepted (the parcel back confirmed in the same step); the ids
async function refusedStatement() {
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
  const returnId = made.json().id as number;
  const rowId = made.json().items[0].id as number;
  const taken = await post(`/api/returns/${returnId}/receive`, {
    results: [{ itemId: rowId, quantity: 3, goods: 'not_accepted', notAcceptedReason: 'used' }],
    parcel: { buyerPaid: 0 },
  });
  expect(taken.statusCode).toBe(200);
  const { paidAt } = await asAdmin((tx) =>
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
  );
  // a moment after the payment, never of the future: the clock of the database, not of the test
  const shippedAt = new Date(paidAt!.getTime() + 1).toISOString();
  return { orderId, returnId, rowId, productName: item!.productName, shippedAt };
}

const sendBack = (
  { returnId, shippedAt }: { returnId: number; shippedAt: string },
  payload: Record<string, unknown>,
) =>
  post(`/api/returns/${returnId}/shipments`, {
    direction: 'to_buyer',
    carrier: 'DHL',
    trackingNumber: 'JD0146000900',
    trackingUrl: 'https://track.example.com/JD0146000900',
    shippedAt,
    ...payload,
  });

describe('POST /api/returns/:returnId/shipments to the buyer', () => {
  it('sends the units not accepted back: the card lists the parcel with its rows, the buyer sees it and is mailed', async () => {
    const made = await refusedStatement();
    const { orderId, returnId, rowId, productName } = made;
    const mails = watchMail();

    const res = await sendBack(made, { items: [{ itemId: rowId, quantity: 2 }], cost: 5 });

    expect(res.statusCode).toBe(201);
    const card = res.json();
    const sent = card.items.find((row: { quantity: number }) => row.quantity === 2);
    expect(card.parcels).toEqual([
      expect.objectContaining({ direction: 'to_shop' }),
      expect.objectContaining({
        direction: 'to_buyer',
        carrier: 'DHL',
        trackingNumber: 'JD0146000900',
        cost: 5,
        itemIds: [sent.id],
        recordedBy: expect.objectContaining({ id: admin.id }),
      }),
    ]);
    expect(card.items.map((row: { quantity: number }) => row.quantity).sort()).toEqual([1, 2]);

    const order = (await get(`/api/orders/${orderId}`, buyer)).json();
    const statement = order.withdrawals.find((one: { id: number }) => one.id === returnId);
    expect(statement.parcels).toEqual([
      expect.objectContaining({ direction: 'to_shop' }),
      expect.objectContaining({
        direction: 'to_buyer',
        carrier: 'DHL',
        trackingNumber: 'JD0146000900',
        confirmed: false,
      }),
    ]);

    const own = mails.filter(
      (mail) =>
        mail.to.includes(buyer.email) &&
        mail.subject.includes(`We sent goods of order #${orderId} back to you`),
    );
    expect(own).toHaveLength(1);
    expect(own[0]!.text).toContain(`- ${productName} x 2`);
    expect(own[0]!.text).toContain('The parcel goes with DHL, number JD0146000900.');
    expect(own[0]!.text).toContain('Follow the parcel: https://track.example.com/JD0146000900');
  });

  it('keeps the step in the admin log with the parcel, its rows and the line of its cost', async () => {
    const made = await refusedStatement();
    const { orderId, rowId } = made;

    const res = await sendBack(made, { items: [{ itemId: rowId, quantity: 3 }], cost: 5 });

    expect(res.statusCode).toBe(201);
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.shipment_record' },
        select: { meta: true },
      }),
    );
    expect(lines).toHaveLength(1);
    const text = JSON.stringify(lines[0]!.meta);
    expect(text).toContain('"direction":"to_buyer"');
    expect(text).toContain(`"itemIds":[${rowId}]`);
    expect(text).toContain('"field":"moneyLogIds"');
  });

  it('asks the rows of a parcel to the buyer (400 RETURN_ITEMS_REQUIRED) and takes none for a parcel to the shop (400 RETURN_ITEMS_NOT_ALLOWED)', async () => {
    const made = await refusedStatement();
    const { returnId, rowId } = made;

    const noRows = await sendBack(made, {});
    const toShop = await sendBack(made, {
      direction: 'to_shop',
      items: [{ itemId: rowId, quantity: 1 }],
    });
    const noDirection = await post(`/api/returns/${returnId}/shipments`, {
      shippedAt: made.shippedAt,
    });

    expect(noRows.statusCode).toBe(400);
    expect(noRows.json()).toMatchObject({ errorCode: 'RETURN_ITEMS_REQUIRED' });
    expect(toShop.statusCode).toBe(400);
    expect(toShop.json()).toMatchObject({ errorCode: 'RETURN_ITEMS_NOT_ALLOWED' });
    expect(noDirection.statusCode).toBe(400);
    expect(noDirection.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('sends back only units not accepted and not sent yet (409 RETURN_NOTHING_TO_SEND_BACK), of the statement (404 RETURN_ITEM_NOT_FOUND)', async () => {
    const made = await refusedStatement();
    const { rowId } = made;
    const other = await refusedStatement();
    await sendBack(made, { items: [{ itemId: rowId, quantity: 3 }] });

    const again = await sendBack(made, {
      items: [{ itemId: rowId, quantity: 1 }],
      trackingNumber: 'JD0146000901',
    });
    const foreign = await sendBack(made, {
      items: [{ itemId: other.rowId, quantity: 1 }],
      trackingNumber: 'JD0146000902',
    });

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'RETURN_NOTHING_TO_SEND_BACK' });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ errorCode: 'RETURN_ITEM_NOT_FOUND' });
  });
});

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
import { placeOrderOf } from '../../../helpers/orders.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';
import { payByCard } from '../../../helpers/stripe.js';

// the parcels the shop paid to carry goods back from a buyer: POST /api/returns/:returnId/shipments
// records one (an admin or root), PATCH .../shipments/:shipmentId writes or corrects its cost. What a
// parcel cost is the money journal: the first cost a line money.return_parcel_cost, a change a line
// money.correction with the difference. The card of the statement lists the parcels with their cost
// and tells how much of it a transfer may still take off for the way back; each step goes to the
// admin log with the lines it wrote

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(admin.id, root.id, buyer.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const send = (
  method: 'POST' | 'PATCH',
  url: string,
  payload: Record<string, unknown>,
  actor: TestUser | null = admin,
) =>
  app.inject({
    method,
    url,
    headers: actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf),
    payload,
  });

// a statement of the admin for a unit of a paid order of the buyer: its id, the order and the moment
// it was paid at, which no parcel is sent before
async function statement() {
  const product = await createProduct({ price: 10, stock: 20 });
  products.push(product);
  const orderId = await placeOrderOf(app, csrf, buyer, [{ item: product, quantity: 2 }], 'paid');
  const items = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
  );
  const res = await send('POST', '/api/returns', {
    orderId,
    items: [{ orderItemId: items[0]!.id, quantity: 1 }],
    basis: 'other',
    reason: 'defect',
  });
  expect(res.statusCode).toBe(201);
  const { paidAt } = await asAdmin((tx) =>
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
  );
  return { returnId: res.json().id as number, orderId, paidAt: paidAt! };
}

const record = (returnId: number, payload: Record<string, unknown>, actor = admin) =>
  send('POST', `/api/returns/${returnId}/shipments`, { direction: 'to_shop', ...payload }, actor);

const setCost = (returnId: number, shipmentId: number, cost: number, actor = admin) =>
  send('PATCH', `/api/returns/${returnId}/shipments/${shipmentId}`, { cost }, actor);

// a moment after the order was paid, never of the future: the test runs seconds after the payment
const afterPay = (paidAt: Date, ms: number) => new Date(paidAt.getTime() + ms).toISOString();

const PARCEL = {
  carrier: 'DHL',
  trackingNumber: 'JD0146000123',
  trackingUrl: 'https://track.example.com/JD0146000123',
  cost: 4.5,
};

describe('POST /api/returns/:returnId/shipments', () => {
  it('records the parcel and answers with the card, which lists it with its time and the admin who recorded it', async () => {
    const { returnId, paidAt } = await statement();
    const shippedAt = afterPay(paidAt, 1);

    const res = await record(returnId, { ...PARCEL, shippedAt });

    expect(res.statusCode).toBe(201);
    expect(res.json().parcels).toEqual([
      {
        id: expect.any(Number),
        direction: 'to_shop',
        ...PARCEL,
        shippedAt,
        recordedBy: { id: admin.id, name: null, email: admin.email },
        confirmedAt: null,
        confirmedBy: null,
        buyerPaid: null,
        itemIds: [],
        createdAt: expect.any(String),
      },
    ]);
  });

  // the goods of a statement go back in one parcel: a second parcel to the shop is refused
  it('records one parcel to the shop a statement (409 RETURN_PARCEL_EXISTS for another)', async () => {
    const { returnId, paidAt } = await statement();

    await record(returnId, { ...PARCEL, shippedAt: afterPay(paidAt, 1) });
    const again = await record(returnId, { shippedAt: afterPay(paidAt, 2) });

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'RETURN_PARCEL_EXISTS' });
  });

  it('lets root record one, and leaves the unknown empty', async () => {
    const { returnId, paidAt } = await statement();

    const res = await record(returnId, { shippedAt: afterPay(paidAt, 2) }, root);

    expect(res.statusCode).toBe(201);
    expect(res.json().parcels).toHaveLength(1);
    expect(res.json().parcels[0]).toMatchObject({
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      cost: null,
      recordedBy: { id: root.id },
    });
  });

  it('writes the step to the log of the admin, naming the statement, the order and the parcel', async () => {
    const { returnId, orderId, paidAt } = await statement();
    const shippedAt = afterPay(paidAt, 1);

    const res = await record(returnId, { ...PARCEL, shippedAt });

    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.shipment_record' },
        select: { actor: { select: { id: true, role: true } }, meta: true },
      }),
    );
    const shipmentId = res.json().parcels[0].id as number;
    const cost = await asAdmin((tx) =>
      tx.moneyLog.findMany({
        where: { orderShipmentId: shipmentId },
        select: { id: true, event: true, purpose: true, amount: true, actorId: true },
      }),
    );
    expect(cost.map((line) => ({ ...line, amount: line.amount.toFixed(2) }))).toEqual([
      {
        id: expect.any(Number),
        event: 'money.return_parcel_cost',
        purpose: 'shipping',
        amount: '-4.50',
        actorId: admin.id,
      },
    ]);
    expect(lines).toEqual([
      {
        actor: { id: admin.id, role: 'ADMIN' },
        meta: [
          { field: 'returnId', old: null, new: returnId },
          { field: 'moneyLogIds', old: null, new: [cost[0]!.id] },
          {
            field: 'shipment',
            old: null,
            new: {
              shipmentId: res.json().parcels[0].id,
              direction: 'to_shop',
              ...PARCEL,
              shippedAt,
            },
          },
        ],
      },
    ]);
  });

  it('refuses a time of the future and a time before the order was paid (400 RETURN_SHIPMENT_TIME_INVALID)', async () => {
    const { returnId } = await statement();

    for (const shippedAt of [
      new Date(Date.now() + 3_600_000).toISOString(),
      '2000-01-01T00:00:00.000Z',
    ]) {
      const res = await record(returnId, { ...PARCEL, shippedAt });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'RETURN_SHIPMENT_TIME_INVALID' });
    }
  });

  it('refuses a statement there is not (404), a body that is not one (400), a buyer (403) and a visitor without a login, who is a guest (403)', async () => {
    const { returnId, paidAt } = await statement();
    const shippedAt = afterPay(paidAt, 1);

    const missing = await record(2_000_000_000, { shippedAt });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ errorCode: 'RETURN_NOT_FOUND' });

    for (const body of [
      {},
      { shippedAt: 'yesterday' },
      { shippedAt, cost: -1 },
      { shippedAt, cost: 1.005 },
      { shippedAt, trackingUrl: 'http://track.example.com/1', carrier: 'DHL' },
      { shippedAt, carrier: '' },
    ]) {
      const res = await record(returnId, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }

    expect((await record(returnId, { shippedAt }, buyer)).statusCode).toBe(403);
    const anonymous = await send(
      'POST',
      `/api/returns/${returnId}/shipments`,
      { direction: 'to_shop', shippedAt },
      null,
    );
    expect(anonymous.statusCode).toBe(403);
    expect(anonymous.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('refuses a number or a link without a carrier (400 RETURN_SHIPMENT_CARRIER_REQUIRED), and nothing is recorded', async () => {
    const { returnId, paidAt } = await statement();
    const shippedAt = afterPay(paidAt, 1);

    for (const body of [
      { shippedAt, trackingNumber: 'JD1' },
      { shippedAt, trackingUrl: 'https://track.example.com/1' },
      { shippedAt, carrier: '   ', trackingNumber: 'JD1' },
    ]) {
      const res = await record(returnId, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'RETURN_SHIPMENT_CARRIER_REQUIRED' });
    }
    expect(await asAdmin((tx) => tx.orderShipment.count({ where: { returnId } }))).toBe(0);
  });
});

describe('PATCH /api/returns/:returnId/shipments/:shipmentId', () => {
  it('writes the cost of a parcel recorded without one, then corrects it, and logs both', async () => {
    const { returnId, orderId, paidAt } = await statement();
    const made = await record(returnId, { shippedAt: afterPay(paidAt, 1) });
    const shipmentId = made.json().parcels[0].id as number;

    const written = await setCost(returnId, shipmentId, 6.25);
    const corrected = await setCost(returnId, shipmentId, 7, root);

    expect(written.statusCode).toBe(200);
    expect(written.json().parcels[0]).toMatchObject({ id: shipmentId, cost: 6.25 });
    expect(corrected.json().parcels[0]).toMatchObject({ cost: 7 });
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.shipment_cost' },
        orderBy: { id: 'asc' },
        select: { actor: { select: { id: true } }, meta: true },
      }),
    );
    // the first cost and the correction with the difference, each a line of the money journal
    const money = await asAdmin((tx) =>
      tx.moneyLog.findMany({
        where: { orderShipmentId: shipmentId },
        orderBy: { id: 'asc' },
        select: { id: true, event: true, amount: true, coversId: true },
      }),
    );
    expect(money.map((line) => [line.event, line.amount.toFixed(2)])).toEqual([
      ['money.return_parcel_cost', '-6.25'],
      ['money.correction', '-0.75'],
    ]);
    expect(money[1]!.coversId).toBe(money[0]!.id);
    expect(lines.map((line) => line.meta)).toEqual([
      [
        { field: 'returnId', old: null, new: returnId },
        { field: 'shipmentId', old: null, new: shipmentId },
        { field: 'moneyLogIds', old: null, new: [money[0]!.id] },
        { field: 'cost', old: null, new: 6.25 },
      ],
      [
        { field: 'returnId', old: null, new: returnId },
        { field: 'shipmentId', old: null, new: shipmentId },
        { field: 'moneyLogIds', old: null, new: [money[1]!.id] },
        { field: 'cost', old: 6.25, new: 7 },
      ],
    ]);
    expect(lines.map((line) => line.actor?.id)).toEqual([admin.id, root.id]);
  });

  it('keeps the time of the parcel when its cost is written', async () => {
    const { returnId, paidAt } = await statement();
    const shippedAt = afterPay(paidAt, 3);
    const made = await record(returnId, { shippedAt });

    const res = await setCost(returnId, made.json().parcels[0].id, 3);

    expect(res.json().parcels[0].shippedAt).toBe(shippedAt);
  });

  it('refuses a parcel of another statement or there is not (404), a cost that is not one (400), a buyer (403)', async () => {
    const mine = await statement();
    const other = await statement();
    const made = await record(other.returnId, { shippedAt: afterPay(other.paidAt, 1) });
    const shipmentId = made.json().parcels[0].id as number;

    const notOfThis = await setCost(mine.returnId, shipmentId, 1);
    expect(notOfThis.statusCode).toBe(404);
    expect(notOfThis.json()).toMatchObject({ errorCode: 'RETURN_SHIPMENT_NOT_FOUND' });
    expect((await setCost(mine.returnId, 2_000_000_000, 1)).statusCode).toBe(404);

    for (const cost of [-1, 1.005]) {
      const res = await setCost(other.returnId, shipmentId, cost);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
    expect((await setCost(other.returnId, shipmentId, 1, buyer)).statusCode).toBe(403);
  });
});

describe('the card of a statement', () => {
  it('lists no parcel for a statement that has none', async () => {
    const { returnId } = await statement();

    const res = await app.inject({
      method: 'GET',
      url: `/api/returns/${returnId}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().parcels).toEqual([]);
    expect(res.json()).toMatchObject({ deductible: 0, warnings: [] });
  });

  // the way back paid back to the buyer would pay for the parcel twice: the card warns, it does not
  // refuse; a statement outside the withdrawal has nothing to take off the transfer
  it('warns of a parcel the shop paid and has nothing to take off a statement outside the withdrawal', async () => {
    const { returnId, paidAt } = await statement();
    expect((await record(returnId, { ...PARCEL, shippedAt: afterPay(paidAt, 1) })).statusCode).toBe(
      201,
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/returns/${returnId}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deductible: 0, warnings: ['shop_paid_parcel'] });
  });

  // the way back the buyer owes of a withdrawal: the order keeps who pays it from the contract in
  // force at its confirmation, set here on the order the way confirm_order sets it (a contract is a
  // state of the whole shop). Two units in two rows: the card tells how much the next transfer may
  // take off, the cost of the parcels less what transfers took for them, while a row waits
  async function withdrawalOf(payer: 'buyer' | 'shop') {
    const first = await createProduct({ price: 10, stock: 20 });
    const second = await createProduct({ price: 10, stock: 20 });
    products.push(first, second);
    const orderId = await placeOrderOf(
      app,
      csrf,
      buyer,
      [
        { item: first, quantity: 1 },
        { item: second, quantity: 1 },
      ],
      'waiting',
    );
    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'USER', userId: buyer.id });
        await db.rows(
          `update cartlify.orders
           set "returnShippingPaidBy" = $2::cartlify."ReturnShippingPayer", "withdrawalDays" = 14
           where id = $1`,
          orderId,
          payer,
        );
      },
      { commit: true },
    );
    const { total } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } }),
    );
    const paymentId = await payByCard(Math.round(Number(total) * 100));
    const [paid] = await asAdmin(
      (tx) => tx.$queryRaw<{ result: string }[]>`
        select cartlify.pay_order(${orderId}::int, 'stripe'::cartlify."PaymentProvider", ${paymentId}, ${total}::numeric) as result
      `,
    );
    expect(paid!.result).toBe('PAID');
    const items = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
    );
    const res = await send('POST', '/api/returns', {
      orderId,
      items: items.map((item) => ({ orderItemId: item.id, quantity: 1 })),
      basis: 'withdrawal',
      // the buyer called the shop to withdraw
      reason: 'other',
    });
    expect(res.statusCode).toBe(201);
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );
    return { card: res.json(), paidAt: paidAt! };
  }

  const cardOf = async (returnId: number) =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/returns/${returnId}`,
        headers: { cookie: accessCookie(admin) },
      })
    ).json();

  it('tells what a transfer may take off for the way back the buyer pays: the cost less what was taken', async () => {
    const { card, paidAt } = await withdrawalOf('buyer');
    const [firstRow, secondRow] = card.items as { id: number }[];

    expect(card).toMatchObject({ deductible: 0, warnings: [] });

    await record(card.id, { carrier: 'DHL', cost: 7, shippedAt: afterPay(paidAt, 1) });
    expect(await cardOf(card.id)).toMatchObject({ deductible: 7, warnings: ['shop_paid_parcel'] });

    // the first row comes back and its money goes with 5 kept for the way back
    const received = await send('POST', `/api/returns/${card.id}/receive`, {
      parcel: { buyerPaid: 0 },
      results: [{ itemId: firstRow!.id, quantity: 1, goods: 'to_stock' }],
    });
    expect(received.statusCode).toBe(200);
    const sent = await send('POST', `/api/returns/${card.id}/refund`, {
      itemIds: [firstRow!.id],
      returnShippingDeduction: 5,
    });
    expect(sent.statusCode).toBe(200);

    const after = await cardOf(card.id);
    expect(after).toMatchObject({ deductible: 2, warnings: ['shop_paid_parcel'] });
    expect(after.items.find((row: { id: number }) => row.id === secondRow!.id)).toMatchObject({
      money: 'not_refunded',
    });
  });

  it('counts only the parcel back to the shop: what the shop paid to send goods not accepted back is not the way back', async () => {
    const { card, paidAt } = await withdrawalOf('buyer');
    const [firstRow, secondRow] = card.items as { id: number }[];
    await record(card.id, { carrier: 'DHL', cost: 7, shippedAt: afterPay(paidAt, 1) });
    const received = await send('POST', `/api/returns/${card.id}/receive`, {
      results: [
        { itemId: firstRow!.id, quantity: 1, goods: 'to_stock' },
        { itemId: secondRow!.id, quantity: 1, goods: 'not_accepted', notAcceptedReason: 'used' },
      ],
      parcel: {},
    });
    expect(received.statusCode).toBe(200);

    const sentBack = await send('POST', `/api/returns/${card.id}/shipments`, {
      direction: 'to_buyer',
      items: [{ itemId: secondRow!.id, quantity: 1 }],
      carrier: 'DHL',
      cost: 6,
      shippedAt: afterPay(paidAt, 2),
    });

    expect(sentBack.statusCode).toBe(201);
    expect(sentBack.json()).toMatchObject({ deductible: 7 });
  });

  it('has nothing to take off when the contract says the shop pays the way back', async () => {
    const { card, paidAt } = await withdrawalOf('shop');

    await record(card.id, { carrier: 'DHL', cost: 7, shippedAt: afterPay(paidAt, 1) });

    expect(await cardOf(card.id)).toMatchObject({ deductible: 0, warnings: ['shop_paid_parcel'] });
  });
});

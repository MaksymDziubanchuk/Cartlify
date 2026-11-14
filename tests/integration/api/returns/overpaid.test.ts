import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
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
import { giveMoneyRight } from '../../../helpers/moneyManager.js';
import { placePaidOrder } from '../../../helpers/payments.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import {
  closeOpenSessions,
  deliver,
  refundAtStripe,
  stripeEvent,
} from '../../../helpers/stripe.js';

// Money already with the buyer for goods no statement of the order owes any more, worked from the
// card of a statement by root or a money admin: POST /api/returns/:returnId/overpaid/received (the buyer gave it back),
// /overpaid/lost (the shop gives it up), /keep (the shop keeps goods not accepted still in the shop).
// The functions of the database are db/moneyOverpaid.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let manager: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const flows = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  manager = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id, root.id, manager.id);
  await giveMoneyRight(root.id, manager.id);
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const dbNow = async () =>
  (
    await asAdmin((tx) => tx.$queryRaw<{ now: Date }[]>`select (now() at time zone 'UTC') as now`)
  )[0]!.now.toISOString();

// a sent order of two units at 10; a statement of an admin for the units named came back used and
// the shop did not accept them; then 10 went back by hand and root gave it to one unit of them
async function overpaid(units = 2) {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const { orderId, paymentId } = await placePaidOrder(app, csrf, buyer, product, {
    quantity: 2,
    stage: 'shipped',
  });
  const item = await asAdmin((tx) =>
    tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } }),
  );
  const card = await flows.adminStatement(orderId, item.id, units);
  await flows.setGoods(card, units, 'not_accepted', { notAcceptedReason: 'used' });

  const refund = await refundAtStripe(paymentId, { amount: 1000 });
  expect((await deliver(app, await stripeEvent('refund.created', refund.id))).statusCode).toBe(200);
  const line = await asAdmin((tx) =>
    tx.moneyLog.findFirstOrThrow({
      where: { refundId: refund.id, event: 'money.refund' },
      select: { id: true },
    }),
  );
  const decided = await flows.post(
    `/api/payments/money-lines/${line.id}/decision`,
    { items: [{ orderItemId: item.id, quantity: 1, amount: 10 }], note: 'For a lamp.' },
    root,
  );
  expect(decided.statusCode).toBe(200);
  return { buyer, orderId, returnId: card.id, rowId: card.items[0]!.id };
}

const received = async (returnId: number, body: Record<string, unknown>, actor = root) =>
  flows.post(
    `/api/returns/${returnId}/overpaid/received`,
    { method: 'bank_transfer', note: 'The buyer paid it back.', at: await dbNow(), ...body },
    actor,
  );

const lost = (returnId: number, actor = root) =>
  flows.post(
    `/api/returns/${returnId}/overpaid/lost`,
    { note: 'The buyer does not answer.' },
    actor,
  );

const keep = (returnId: number, items: unknown[], actor = root) =>
  flows.post(`/api/returns/${returnId}/keep`, { items, note: 'The shop keeps the lamp.' }, actor);

const auditOf = (orderId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, event },
      select: { actorId: true },
    }),
  );

describe('the card of the statement', () => {
  it('tells what is overpaid', async () => {
    const { returnId } = await overpaid();

    expect(await flows.cardOf(returnId)).toMatchObject({ moneyOverpaid: 10 });
  });
});

describe('POST /api/returns/:returnId/overpaid/received', () => {
  it('takes money the buyer gave back: nothing overpaid, no mail, a line of the actor', async () => {
    const { buyer, orderId, returnId } = await overpaid();
    const mails = watchMail();

    const res = await received(returnId, { amount: 10 }, manager);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: returnId, moneyOverpaid: 0 });
    expect(mails.filter((mail) => mail.to.includes(buyer.email))).toEqual([]);
    expect(await auditOf(orderId, 'return.overpaid_received')).toEqual([{ actorId: manager.id }]);
  });

  it('refuses more than is overpaid, a day to come, a statement that is not there, and an admin without the right', async () => {
    const { returnId } = await overpaid();

    const more = await received(returnId, { amount: 10.01 });
    const later = await received(returnId, { amount: 1, at: '2999-01-01T00:00:00.000Z' });
    const none = await received(2_147_483_000, { amount: 1 });
    const plain = await received(returnId, { amount: 1 }, admin);

    expect(more.statusCode).toBe(409);
    expect(more.json()).toMatchObject({ errorCode: 'MONEY_RECEIVED_EXCEEDS' });
    expect(later.statusCode).toBe(400);
    expect(later.json()).toMatchObject({ errorCode: 'MONEY_RECEIVED_AT_INVALID' });
    expect(none.statusCode).toBe(404);
    expect(none.json()).toMatchObject({ errorCode: 'MONEY_RECEIVED_NOT_FOUND' });
    expect(plain.statusCode).toBe(403);
    expect(plain.json()).toMatchObject({ errorCode: 'MONEY_MANAGER_REQUIRED' });
  });

  it.each([{ amount: 0 }, { amount: 1.234 }, { amount: 1, method: 'cheque' }, { note: '' }])(
    'refuses a body that is none: %j',
    async (body) => {
      const res = await received(1, { amount: 1, ...body });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    },
  );
});

describe('POST /api/returns/:returnId/overpaid/lost', () => {
  it('gives what is overpaid up: nothing overpaid, a line of the actor with the reason', async () => {
    const { orderId, returnId } = await overpaid();

    const res = await lost(returnId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: returnId, moneyOverpaid: 0 });
    expect(await auditOf(orderId, 'return.overpaid_lost')).toEqual([{ actorId: root.id }]);
  });

  it('refuses when nothing is overpaid, and an admin without the right', async () => {
    const { returnId } = await overpaid();
    expect((await lost(returnId)).statusCode).toBe(200);

    const again = await lost(returnId);
    const plain = await lost(returnId, admin);

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'MONEY_OVERPAID_NONE' });
    expect(plain.statusCode).toBe(403);
    expect(plain.json()).toMatchObject({ errorCode: 'MONEY_MANAGER_REQUIRED' });
  });
});

describe('POST /api/returns/:returnId/keep', () => {
  it('keeps the goods: the money already there pays the row at once and the buyer is told', async () => {
    const { buyer, orderId, returnId, rowId } = await overpaid(1);
    const mails = watchMail();

    const res = await keep(returnId, [{ itemId: rowId, goods: 'written_off' }]);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: returnId,
      refundedTotal: 10,
      closedAt: expect.any(String),
      items: [expect.objectContaining({ goods: 'written_off', money: 'refunded' })],
    });
    expect(mails.filter((mail) => mail.to.includes(buyer.email)).length).toBeGreaterThan(0);
    expect(await auditOf(orderId, 'return.goods_kept')).toEqual([{ actorId: root.id }]);
  });

  it('with part of the price there, the statement waits and the transfer sends the rest', async () => {
    const { returnId, rowId } = await overpaid(2);

    const kept = await keep(returnId, [{ itemId: rowId, goods: 'to_stock' }]);
    expect(kept.statusCode).toBe(200);
    expect(kept.json()).toMatchObject({ refundedTotal: 0, closedAt: null });

    const sent = await flows.post(`/api/returns/${returnId}/refund`, {});
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ refundedTotal: 20 });
  });

  it('refuses a row named twice, a row the shop took in, a statement that is not there, and an admin without the right', async () => {
    const { returnId, rowId } = await overpaid(1);

    const twice = await keep(returnId, [
      { itemId: rowId, goods: 'to_stock' },
      { itemId: rowId, goods: 'written_off' },
    ]);
    const none = await keep(2_147_483_000, [{ itemId: rowId, goods: 'to_stock' }]);
    const plain = await keep(returnId, [{ itemId: rowId, goods: 'to_stock' }], admin);
    expect((await keep(returnId, [{ itemId: rowId, goods: 'to_stock' }])).statusCode).toBe(200);
    const again = await keep(returnId, [{ itemId: rowId, goods: 'written_off' }]);

    expect(twice.statusCode).toBe(400);
    expect(twice.json()).toMatchObject({ errorCode: 'RETURN_KEEP_INVALID' });
    expect(none.statusCode).toBe(404);
    expect(none.json()).toMatchObject({ errorCode: 'RETURN_NOT_FOUND' });
    expect(plain.statusCode).toBe(403);
    expect(plain.json()).toMatchObject({ errorCode: 'MONEY_MANAGER_REQUIRED' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ errorCode: 'RETURN_KEEP_NOT_ALLOWED' });
  });

  it.each([
    { items: [] },
    { items: [{ itemId: 1, goods: 'lost' }] },
    { items: [{ itemId: 1 }] },
    { items: [{ itemId: 1, goods: 'to_stock' }], note: '' },
  ])('refuses a body that is none: %j', async (body) => {
    const res = await flows.post(
      '/api/returns/1/keep',
      { note: 'The shop keeps it.', ...body },
      root,
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

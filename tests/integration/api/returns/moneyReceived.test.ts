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
import { closeOpenSessions } from '../../../helpers/stripe.js';

// POST /api/returns/:returnId/money-received: root (or a money admin) records money the buyer gave
// the shop back outside the app for rows of a statement whose money the buyer had.
// The function of the database is db/moneyReceived.test.ts

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

// a sent order of two units at 10, a statement of an admin for both, the goods in and the money
// sent: the row is refunded (20)
async function refundedStatement() {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const { orderId } = await placePaidOrder(app, csrf, buyer, product, {
    quantity: 2,
    stage: 'shipped',
  });
  const item = await asAdmin((tx) =>
    tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } }),
  );
  const card = await flows.adminStatement(orderId, item.id, 2);
  await flows.setGoods(card, 2, 'to_stock');
  const refunded = await flows.post(`/api/returns/${card.id}/refund`, {});
  expect(refunded.statusCode).toBe(200);
  return { orderId, returnId: card.id, rowId: card.items[0]!.id, buyer };
}

const dbNow = async () =>
  (
    await asAdmin((tx) => tx.$queryRaw<{ now: Date }[]>`select (now() at time zone 'UTC') as now`)
  )[0]!.now.toISOString();

const received = async (returnId: number, body: Record<string, unknown>, actor: TestUser = root) =>
  flows.post(
    `/api/returns/${returnId}/money-received`,
    { method: 'bank_transfer', note: 'The buyer paid it back.', at: await dbNow(), ...body },
    actor,
  );

describe('money the buyer gave back outside the app', () => {
  it('is written on the rows, the statement has that much less back, and the buyer is not mailed', async () => {
    const statement = await refundedStatement();
    const mails = watchMail();

    const res = await received(statement.returnId, {
      items: [{ itemId: statement.rowId, amount: 10 }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: statement.returnId, refundedTotal: 10 });
    expect(res.json().money).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'money.received',
          purpose: 'return',
          part: 'goods',
          amount: 10,
          method: 'bank_transfer',
        }),
      ]),
    );
    expect(mails.filter((mail) => mail.to.includes(statement.buyer.email))).toEqual([]);
    const audit = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: statement.orderId, event: 'return.money_received' },
        select: { actorId: true },
      }),
    );
    expect(audit).toEqual([{ actorId: root.id }]);
  });

  it('is for root and a money admin: an admin without the right and a buyer are refused', async () => {
    const statement = await refundedStatement();
    const items = [{ itemId: statement.rowId, amount: 1 }];

    for (const actor of [admin, statement.buyer]) {
      const res = await received(statement.returnId, { items }, actor);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        errorCode: actor === admin ? 'MONEY_MANAGER_REQUIRED' : 'INSUFFICIENT_ROLE',
      });
    }
    expect((await received(statement.returnId, { items }, manager)).statusCode).toBe(200);
  });

  it('refuses more than the row cost, a statement that is not there, and a day of the future', async () => {
    const statement = await refundedStatement();

    const over = await received(statement.returnId, {
      items: [{ itemId: statement.rowId, amount: 20.01 }],
    });
    const none = await received(2_147_483_000, { items: [{ itemId: statement.rowId, amount: 1 }] });
    const future = await received(statement.returnId, {
      items: [{ itemId: statement.rowId, amount: 1 }],
      at: '2999-01-01T00:00:00.000Z',
    });
    const blank = await received(statement.returnId, {
      items: [{ itemId: statement.rowId, amount: 1 }],
      note: '   ',
    });

    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ errorCode: 'MONEY_RECEIVED_EXCEEDS' });
    expect(none.statusCode).toBe(404);
    expect(none.json()).toMatchObject({ errorCode: 'MONEY_RECEIVED_NOT_FOUND' });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toMatchObject({ errorCode: 'MONEY_RECEIVED_AT_INVALID' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ errorCode: 'MONEY_RECEIVED_NOTE_REQUIRED' });
  });

  it.each([
    { items: [] },
    { items: [{ itemId: 1, amount: 0 }] },
    { items: [{ itemId: 1, amount: 1.234 }] },
    { items: [{ itemId: 1 }] },
    { items: [{ itemId: 1, amount: 1 }], method: 'cheque' },
  ])('refuses a body that is none: %j', async (body) => {
    const statement = await refundedStatement();

    const res = await received(statement.returnId, body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

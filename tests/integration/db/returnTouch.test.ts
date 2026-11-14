import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inCommittedTx, type DbSession } from '../../helpers/db.js';
import { paidOrderOf } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the time of the last change of a statement follows the changes of its rows: the list of the
// statements sorted by it shows the work on the rows too. Each step is a transaction of its own,
// so the database gives each its own time

let buyer: TestUser;
let admin: TestUser;
let product: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  product = await createProduct({ price: 10, stock: 20 });
});

afterAll(async () => {
  try {
    await removeProducts([product]);
    await closeSessions([buyer.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asAdmin = (db: DbSession) => db.as({ role: 'ADMIN', userId: admin.id });

const updatedAtOf = (returnId: number) =>
  inCommittedTx(async (db) => {
    await asAdmin(db);
    const [row] = await db.rows<{ at: string }>(
      `select "updatedAt"::text as at from cartlify.returns where id = $1`,
      returnId,
    );
    return row!.at;
  });

const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('trg_return_items_touch_return', () => {
  it('moves the updatedAt of the statement when the goods of a row come in, and when its money starts and ends', async () => {
    const { returnId, rowId } = await inCommittedTx(async (db) => {
      const orderId = await paidOrderOf(db, buyer.id, admin.id, [[product.variantId, 2]], {});
      await asAdmin(db);
      const [item] = await db.rows<{ id: number }>(
        `select id from cartlify.order_items where "orderId" = $1`,
        orderId,
      );
      const [made] = await db.rows<{ id: number }>(
        `select cartlify.create_return(
           $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
           'defect'::cartlify."ReturnReason", null, 'Anna', 'anna@example.com', null, null, 4,
           'Europe/Madrid'
         ) as id`,
        orderId,
        JSON.stringify([{ orderItemId: item!.id, quantity: 2 }]),
      );
      const [row] = await db.rows<{ id: number }>(
        `select id from cartlify.return_items where "returnId" = $1`,
        made!.id,
      );
      return { returnId: made!.id, rowId: row!.id };
    });
    const made = await updatedAtOf(returnId);

    // the goods come in
    await pause();
    await inCommittedTx(async (db) => {
      await asAdmin(db);
      await db.rows(
        `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
        returnId,
        JSON.stringify([{ itemId: rowId, quantity: 2, goods: 'to_stock' }]),
      );
    });
    const received = await updatedAtOf(returnId);

    // the money starts
    await pause();
    const key = await inCommittedTx(async (db) => {
      await asAdmin(db);
      const [row] = await db.rows<{ done: { key: string } }>(
        `select cartlify.begin_return_refund($1::int, null::int[], null::jsonb) as done`,
        returnId,
      );
      return row!.done.key;
    });
    const begun = await updatedAtOf(returnId);

    // and ends: the provider says it went (the rows are committed, so the id of the refund is the
    // test's own)
    await pause();
    await inCommittedTx(async (db) => {
      await asAdmin(db);
      await db.rows(
        `select cartlify.settle_money_refund($1::text, $2::text, 'succeeded', null, null) as done`,
        key,
        `re_touch_${randomUUID()}`,
      );
    });
    const settled = await updatedAtOf(returnId);

    expect(received > made).toBe(true);
    expect(begun > received).toBe(true);
    expect(settled > begun).toBe(true);
  });
});

// where an order stands as to its statements is a summary the database keeps, no change of the
// order: a shipped order keeps the time it was sent, which the alerts of the sends count from
describe('the updatedAt of an order and its statements', () => {
  it('stays when a statement changes only the return status of the order', async () => {
    const orderId = await inCommittedTx(async (db) => {
      const id = await paidOrderOf(db, buyer.id, admin.id, [[product.variantId, 1]], {});
      await asAdmin(db);
      await db.rows(`update cartlify.orders set status = 'shipped' where id = $1 returning id`, id);
      return id;
    });
    const orderAt = () =>
      inCommittedTx(async (db) => {
        await asAdmin(db);
        const [row] = await db.rows<{ at: string; returnStatus: string }>(
          `select "updatedAt"::text as at, "returnStatus"::text as "returnStatus"
           from cartlify.orders where id = $1`,
          orderId,
        );
        return row!;
      });
    const shipped = await orderAt();

    await pause();
    await inCommittedTx(async (db) => {
      await asAdmin(db);
      const [item] = await db.rows<{ id: number }>(
        `select id from cartlify.order_items where "orderId" = $1`,
        orderId,
      );
      await db.rows(
        `select cartlify.create_return(
           $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
           'defect'::cartlify."ReturnReason", null, 'Anna', 'anna@example.com', null, null, 4,
           'Europe/Madrid'
         ) as id`,
        orderId,
        JSON.stringify([{ orderItemId: item!.id, quantity: 1 }]),
      );
    });
    const stated = await orderAt();

    expect(stated.returnStatus).toBe('open');
    expect(shipped.returnStatus).toBe('none');
    expect(stated.at).toBe(shipped.at);
  });
});

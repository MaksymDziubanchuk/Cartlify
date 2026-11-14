import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { paidOrderOf, type DeliveryRule, type Items } from '../../helpers/dbOrders.js';
import {
  handRefundOf,
  holdsOf,
  itemIdsOf,
  reasonsOf,
  shopCancelOf,
  stepOf,
} from '../../helpers/dbMoney.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// The refunds made by hand in the dashboard of the provider, in the database: the hold such a refund
// puts on an order that waits to be sent. What root says such a refund was for, and the money it
// gives a later statement, is decide_money_use (moneyDecisions.test.ts). All in transactions that
// roll back.
//
// cartlify.record_hand_refund (moneyPayments.test.ts) also holds the order: a new line of a refund
// made by hand of the payment of an order whose status is paid puts the hold
// { reason: 'hand_refund', since, ref: <the id of the line> } (the rule of the user: an order not
// sent is not sent until root knows what the refund was). An order already shipped, delivered or
// cancelled is not held: root decides what the refund was for.

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let first: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  first = await createProduct({ price: 10, stock: 400 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

// the units at 10 and a delivery of 5: an order of 25
const DELIVERY: DeliveryRule = { flat: 5, freeFrom: null, expected: 5 };

type Paid = { orderId: number; paymentId: string; itemIds: number[] };

// a paid order of 25: two units of the product
async function paidOrder(db: DbSession): Promise<Paid> {
  const items: Items = [[first.variantId, 2]];
  const orderId = await paidOrderOf(db, buyer.id, admin.id, items, DELIVERY);
  return {
    orderId,
    paymentId: `pi_db_${orderId}`,
    itemIds: await itemIdsOf(db, admin.id, orderId),
  };
}

describe('a refund by hand of an order that waits to be sent', () => {
  it('holds the order, one hold for each refund, named by its line', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const a = await handRefundOf(db, order.paymentId, 5);
      const b = await handRefundOf(db, order.paymentId, 3, 'pending');
      return { a, b, holds: await holdsOf(db, admin.id, order.orderId) };
    });

    expect(reasonsOf(result.holds)).toEqual([
      ['hand_refund', result.a.id],
      ['hand_refund', result.b.id],
    ]);
  });

  it.each([['shipped'], ['delivered'], ['cancelled']])(
    'holds no order that is %s',
    async (status) => {
      const holds = await inRolledBackTx(async (db) => {
        const order = await paidOrder(db);
        if (status === 'cancelled') {
          await shopCancelOf(db, admin.id, order.orderId);
        } else {
          const shipped = await stepOf(db, admin.id, order.orderId, 'shipped');
          if (!shipped.ok) throw new Error(`the order was not shipped: ${shipped.message}`);
          if (status === 'delivered') {
            const delivered = await stepOf(db, admin.id, order.orderId, 'delivered');
            if (!delivered.ok) throw new Error(`the order was not delivered: ${delivered.message}`);
          }
        }
        await handRefundOf(db, order.paymentId, 5);
        return holdsOf(db, admin.id, order.orderId);
      });

      expect(holds).toEqual([]);
    },
  );
});

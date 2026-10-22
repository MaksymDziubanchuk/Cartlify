import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import {
  addItem,
  cartOf,
  changedRows,
  orderDatesOf,
  orderStateOf,
  paidOrderOf,
  stockOf,
  waitingOrderOf,
} from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the rows of orders and order_items and the stock of a product under each role: who reads and
// who changes what with a plain statement. A user keeps a cart: opens it, fills it, writes the
// shipping data, deletes it; every other step of an order (confirm, payment, cancel, end of the
// reservation) is a database function, an admin moves a paid order on to shipped and delivered

let owner: TestUser;
let other: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;
let cheap: TestProduct;
let removed: TestProduct;

beforeAll(async () => {
  owner = await createUser();
  other = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ price: 10, stock: 10 });
  cheap = await createProduct({ price: 4, stock: 10 });
  removed = await createProduct({ price: 7, stock: 10 });
  await deleteProductFromCatalog(removed.id);
});

afterAll(async () => {
  try {
    await closeSessions([owner.id, other.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const idsSeen = async (db: DbSession, table: 'orders' | 'order_items', ids: number[]) =>
  (
    await db.rows<{ id: number }>(
      `select id from cartlify.${table} where id = any($1::int[]) order by id`,
      ids,
    )
  ).map((row) => row.id);

const updateOrder = (db: DbSession, set: string, orderId: number, ...values: unknown[]) =>
  db.attempt(`update cartlify.orders set ${set} where id = $1 returning id`, orderId, ...values);

const itemOf = async (db: DbSession, itemId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const [row] = await db.rows<{ unitPrice: number; totalPrice: number; quantity: number }>(
    `select "unitPrice"::float8 as "unitPrice", "totalPrice"::float8 as "totalPrice", quantity
     from cartlify.order_items where id = $1`,
    itemId,
  );
  return row;
};

const itemsOf = async (db: DbSession, orderId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  return db.rows<{ id: number }>(
    'select id from cartlify.order_items where "orderId" = $1',
    orderId,
  );
};

describe('orders: reading', () => {
  it('shows a user only own orders', async () => {
    const { own, seen } = await inRolledBackTx(async (db) => {
      const own = await cartOf(db, owner.id, [[product.id, 1]]);
      const foreign = await cartOf(db, other.id, [[product.id, 1]]);
      await db.as({ role: 'USER', userId: owner.id });
      return { own, seen: await idsSeen(db, 'orders', [own, foreign]) };
    });

    expect(seen).toEqual([own]);
  });

  it.each(['ADMIN', 'ROOT'] as const)('shows an %s the orders of every user', async (role) => {
    const { ids, seen } = await inRolledBackTx(async (db) => {
      const ids = [
        await cartOf(db, owner.id, [[product.id, 1]]),
        await cartOf(db, other.id, [[product.id, 1]]),
      ];
      await db.as({ role, userId: role === 'ADMIN' ? admin.id : root.id });
      return { ids, seen: await idsSeen(db, 'orders', ids) };
    });

    expect(seen).toEqual(ids);
  });

  it('shows a guest no order', async () => {
    const seen = await inRolledBackTx(async (db) => {
      const id = await cartOf(db, owner.id, [[product.id, 1]]);
      await db.as({ role: 'GUEST', guestId: randomUUID() });
      return idsSeen(db, 'orders', [id]);
    });

    expect(seen).toEqual([]);
  });
});

describe('orders: a new order', () => {
  it('lets a user open a cart of their own', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: owner.id });
      return db.attempt(
        'insert into cartlify.orders ("userId", total) values ($1, 0) returning id',
        owner.id,
      );
    });

    expect(changedRows(outcome)).toBe(true);
  });

  it.each([
    ['of another user', '"userId", total', () => [other.id], '$1, 0'],
    ['that is confirmed', '"userId", total, confirmed', () => [owner.id], '$1, 0, true'],
    [
      'that waits for its payment',
      '"userId", total, confirmed, status, "reservationExpiresAt"',
      () => [owner.id],
      `$1, 0, true, 'waiting', now() + interval '1 hour'`,
    ],
    [
      'that is paid',
      '"userId", total, confirmed, status, "paymentProvider", "paymentId"',
      () => [owner.id],
      `$1, 0, true, 'paid', 'stripe', 'pi_forged'`,
    ],
    [
      'that lost its reservation',
      '"userId", total, status',
      () => [owner.id],
      `$1, 0, 'unconfirmed'`,
    ],
    ['with a time of payment', '"userId", total, "paidAt"', () => [owner.id], '$1, 0, now()'],
    ['with a time of cancel', '"userId", total, "cancelledAt"', () => [owner.id], '$1, 0, now()'],
  ])('refuses a user an order %s', async (_case, columns, values, placeholders) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: owner.id });
      return db.attempt(
        `insert into cartlify.orders (${columns}) values (${placeholders}) returning id`,
        ...values(),
      );
    });

    expect(outcome.ok).toBe(false);
  });

  it.each(['GUEST', 'ADMIN', 'ROOT'] as const)('refuses a %s a cart for a user', async (role) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(role === 'GUEST' ? { role, guestId: randomUUID() } : { role, userId: admin.id });
      return db.attempt(
        'insert into cartlify.orders ("userId", total) values ($1, 0) returning id',
        owner.id,
      );
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('orders: a user changes an own order', () => {
  it('lets a user write the shipping data and a note of an own cart', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]], { shipping: false });
      await db.as({ role: 'USER', userId: owner.id });
      return updateOrder(
        db,
        `"shippingAddress" = 'Main street 5', "recipientFirstName" = 'Anna',
         "recipientLastName" = 'Koval', "recipientPhone" = '+380501234567', note = 'Ring twice'`,
        orderId,
      );
    });

    expect(changedRows(outcome)).toBe(true);
  });

  // a plain update of the owner writes the shipping data; the status, the total, the payment and
  // the reservation change only through the steps of the database
  it.each([
    ['confirm it', 'confirmed = true', () => []],
    [
      'make it wait for a payment',
      `confirmed = true, status = 'waiting', "reservationExpiresAt" = now() + interval '1 hour'`,
      () => [],
    ],
    [
      'mark it paid',
      `confirmed = true, status = 'paid', "paymentProvider" = 'stripe', "paymentId" = 'pi_forged'`,
      () => [],
    ],
    ['give it to another user', '"userId" = $2', () => [other.id]],
    ['change its status', `status = 'unconfirmed'`, () => []],
    ['set its total', 'total = 0.01', () => []],
    ['change when it was made', `"createdAt" = now() - interval '1 year'`, () => []],
    ['give it a time of payment', `"paidAt" = now()`, () => []],
    ['give it a time of cancel', `"cancelledAt" = now()`, () => []],
  ])('does not let a user %s with a plain update', async (_case, set, values) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 2]]);
      await db.as({ role: 'USER', userId: owner.id });
      return updateOrder(db, set, orderId, ...values());
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it.each(['waiting', 'paid'] as const)(
    'does not let a user change an own order that is %s',
    async (stage) => {
      const outcome = await inRolledBackTx(async (db) => {
        const orderId =
          stage === 'waiting'
            ? await waitingOrderOf(db, owner.id, [[product.id, 1]])
            : await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
        await db.as({ role: 'USER', userId: owner.id });
        return updateOrder(db, `"shippingAddress" = 'Elsewhere 2'`, orderId);
      });

      expect(changedRows(outcome)).toBe(false);
    },
  );

  it('does not let a user change or delete the order of another user', async () => {
    const { update, removal } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, other.id, [[product.id, 1]]);
      await db.as({ role: 'USER', userId: owner.id });
      return {
        update: await updateOrder(db, `"shippingAddress" = 'Elsewhere 2'`, orderId),
        removal: await db.attempt(
          'delete from cartlify.orders where id = $1 returning id',
          orderId,
        ),
      };
    });

    expect(changedRows(update)).toBe(false);
    expect(changedRows(removal)).toBe(false);
  });

  it('lets a user delete an own cart, not an order that is confirmed', async () => {
    const { cart, waiting } = await inRolledBackTx(async (db) => {
      const cartId = await cartOf(db, owner.id, [[product.id, 1]]);
      const waitingId = await waitingOrderOf(db, owner.id, [[cheap.id, 1]]);
      await db.as({ role: 'USER', userId: owner.id });
      return {
        cart: await db.attempt('delete from cartlify.orders where id = $1 returning id', cartId),
        waiting: await db.attempt(
          'delete from cartlify.orders where id = $1 returning id',
          waitingId,
        ),
      };
    });

    expect(changedRows(cart)).toBe(true);
    expect(changedRows(waiting)).toBe(false);
  });
});

describe('orders: an admin', () => {
  it('moves a paid order to shipped and then to delivered', async () => {
    const { shipped, delivered, state } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const shipped = await updateOrder(db, `status = 'shipped'`, orderId);
      const delivered = await updateOrder(db, `status = 'delivered'`, orderId);
      return { shipped, delivered, state: await orderStateOf(db, admin.id, orderId) };
    });

    expect(changedRows(shipped)).toBe(true);
    expect(changedRows(delivered)).toBe(true);
    expect(state).toMatchObject({ status: 'delivered', paymentProvider: 'stripe' });
  });

  it('keeps the time of the payment when the order is shipped and delivered', async () => {
    const { paid, delivered } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      const paid = await orderDatesOf(db, admin.id, orderId);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await updateOrder(db, `status = 'shipped'`, orderId);
      await updateOrder(db, `status = 'delivered'`, orderId);
      return { paid, delivered: await orderDatesOf(db, admin.id, orderId) };
    });

    expect(paid.paidAt).not.toBeNull();
    expect(delivered).toEqual(paid);
  });

  it.each([
    [
      'cancel it with a plain update, past the refund and the stock',
      `status = 'cancelled'`,
      () => [],
    ],
    ['move it back to waiting', `status = 'waiting'`, () => []],
    ['change its total', 'total = 0', () => []],
    ['change its address', `"shippingAddress" = 'Elsewhere 2'`, () => []],
    ['give it to another user', '"userId" = $2', () => [other.id]],
    ['change its payment', `"paymentId" = 'pi_other'`, () => []],
    ['change the time of its payment', `"paidAt" = now() - interval '1 day'`, () => []],
    ['take the time of its payment away', `"paidAt" = null`, () => []],
    ['give it a time of cancel', `"cancelledAt" = now()`, () => []],
    ['ship it with a time of cancel', `status = 'shipped', "cancelledAt" = now()`, () => []],
  ])('does not let an admin %s', async (_case, set, values) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      await db.as({ role: 'ADMIN', userId: admin.id });
      return updateOrder(db, set, orderId, ...values());
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it.each(['cart', 'waiting'] as const)(
    'does not let an admin ship an order that is not paid (%s)',
    async (stage) => {
      const outcome = await inRolledBackTx(async (db) => {
        const orderId =
          stage === 'cart'
            ? await cartOf(db, owner.id, [[product.id, 1]])
            : await waitingOrderOf(db, owner.id, [[product.id, 1]]);
        await db.as({ role: 'ADMIN', userId: admin.id });
        return updateOrder(db, `status = 'shipped'`, orderId);
      });

      expect(changedRows(outcome)).toBe(false);
    },
  );

  it('does not let an admin move a delivered order back', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await updateOrder(db, `status = 'delivered'`, orderId);
      return updateOrder(db, `status = 'shipped'`, orderId);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it('does not let an admin delete an order', async () => {
    const { paid, cart } = await inRolledBackTx(async (db) => {
      const paidId = await paidOrderOf(db, owner.id, admin.id, [[product.id, 1]]);
      const cartId = await cartOf(db, owner.id, [[cheap.id, 1]]);
      await db.as({ role: 'ADMIN', userId: admin.id });
      return {
        paid: await db.attempt('delete from cartlify.orders where id = $1 returning id', paidId),
        cart: await db.attempt('delete from cartlify.orders where id = $1 returning id', cartId),
      };
    });

    expect(changedRows(paid)).toBe(false);
    expect(changedRows(cart)).toBe(false);
  });
});

describe('order items', () => {
  it('shows a user only the items of own orders, an admin every item', async () => {
    const { own, foreign, asOwner, asAdmin } = await inRolledBackTx(async (db) => {
      const ownOrder = await cartOf(db, owner.id, [[product.id, 1]]);
      const foreignOrder = await cartOf(db, other.id, [[product.id, 1]]);
      const own = (await itemsOf(db, ownOrder)).map((row) => row.id);
      const foreign = (await itemsOf(db, foreignOrder)).map((row) => row.id);

      await db.as({ role: 'USER', userId: owner.id });
      const asOwner = await idsSeen(db, 'order_items', [...own, ...foreign]);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const asAdmin = await idsSeen(db, 'order_items', [...own, ...foreign]);
      return { own, foreign, asOwner, asAdmin };
    });

    expect(asOwner).toEqual(own);
    expect(asAdmin).toEqual([...own, ...foreign].sort((a, b) => a - b));
  });

  it('takes the price of an item from the product, whatever price comes with it', async () => {
    const { item, state } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, []);
      await db.as({ role: 'USER', userId: owner.id });
      const [row] = await db.rows<{ id: number }>(
        `insert into cartlify.order_items ("orderId", "productId", quantity, "unitPrice", "totalPrice")
         values ($1, $2, 3, 0.01, 0.01) returning id`,
        orderId,
        product.id,
      );
      return { item: await itemOf(db, row!.id), state: await orderStateOf(db, admin.id, orderId) };
    });

    expect(item).toEqual({ unitPrice: 10, totalPrice: 30, quantity: 3 });
    expect(state).toMatchObject({ total: 30 });
  });

  it('counts the total of the order again on every change of its items', async () => {
    const totals = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, []);
      const first = await addItem(db, owner.id, orderId, [product.id, 1]);
      await addItem(db, owner.id, orderId, [cheap.id, 2]);
      const added = (await orderStateOf(db, admin.id, orderId))!.total;

      await db.as({ role: 'USER', userId: owner.id });
      await db.rows(
        'update cartlify.order_items set quantity = 3 where id = $1 returning id',
        first,
      );
      const changed = (await orderStateOf(db, admin.id, orderId))!.total;

      await db.as({ role: 'USER', userId: owner.id });
      await db.rows('delete from cartlify.order_items where id = $1 returning id', first);
      const removedOne = (await orderStateOf(db, admin.id, orderId))!.total;

      return { added, changed, removedOne };
    });

    expect(totals).toEqual({ added: 18, changed: 38, removedOne: 8 });
  });

  it.each([0, -1])('refuses a quantity of %s', async (quantity) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, []);
      await db.as({ role: 'USER', userId: owner.id });
      return db.attempt(
        `insert into cartlify.order_items ("orderId", "productId", quantity, "unitPrice", "totalPrice")
         values ($1, $2, $3, 0, 0) returning id`,
        orderId,
        product.id,
        quantity,
      );
    });

    expect(outcome.ok).toBe(false);
  });

  it('does not let a user put an item into the order of another user', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, other.id, []);
      await db.as({ role: 'USER', userId: owner.id });
      return db.attempt(
        `insert into cartlify.order_items ("orderId", "productId", quantity, "unitPrice", "totalPrice")
         values ($1, $2, 1, 0, 0) returning id`,
        orderId,
        product.id,
      );
    });

    expect(outcome.ok).toBe(false);
  });

  it('does not let a user move an item into the order of another user', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const ownOrder = await cartOf(db, owner.id, [[product.id, 1]]);
      const foreignOrder = await cartOf(db, other.id, []);
      const [item] = await itemsOf(db, ownOrder);
      await db.as({ role: 'USER', userId: owner.id });
      return db.attempt(
        'update cartlify.order_items set "orderId" = $2 where id = $1 returning id',
        item!.id,
        foreignOrder,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it('does not let a user add, change or remove an item of an own confirmed order', async () => {
    const { added, changed, removal } = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      const [item] = await itemsOf(db, orderId);
      await db.as({ role: 'USER', userId: owner.id });
      return {
        added: await db.attempt(
          `insert into cartlify.order_items ("orderId", "productId", quantity, "unitPrice", "totalPrice")
           values ($1, $2, 1, 0, 0) returning id`,
          orderId,
          cheap.id,
        ),
        changed: await db.attempt(
          'update cartlify.order_items set quantity = 5 where id = $1 returning id',
          item!.id,
        ),
        removal: await db.attempt(
          'delete from cartlify.order_items where id = $1 returning id',
          item!.id,
        ),
      };
    });

    expect(added.ok).toBe(false);
    expect(changedRows(changed)).toBe(false);
    expect(changedRows(removal)).toBe(false);
  });

  // the app does not offer it, the database is the last line that holds
  it('does not let a user put a product removed from the catalog into a cart', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, []);
      await db.as({ role: 'USER', userId: owner.id });
      return db.attempt(
        `insert into cartlify.order_items ("orderId", "productId", quantity, "unitPrice", "totalPrice")
         values ($1, $2, 1, 0, 0) returning id`,
        orderId,
        removed.id,
      );
    });

    expect(outcome.ok).toBe(false);
  });

  it('does not let a user switch an item to a product removed from the catalog', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]]);
      const [item] = await itemsOf(db, orderId);
      await db.as({ role: 'USER', userId: owner.id });
      return db.attempt(
        'update cartlify.order_items set "productId" = $2 where id = $1 returning id',
        item!.id,
        removed.id,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });

  // the app drops such an item when it reads the order; until then it is the owner's to change
  it('lets a user change an item whose product was removed after it went in', async () => {
    const { outcome, item } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[cheap.id, 1]]);
      const [row] = await itemsOf(db, orderId);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await db.rows(
        'update cartlify.products set "deletedAt" = now() where id = $1 returning id',
        cheap.id,
      );
      await db.as({ role: 'USER', userId: owner.id });
      const outcome = await db.attempt(
        'update cartlify.order_items set quantity = 2 where id = $1 returning id',
        row!.id,
      );
      return { outcome, item: await itemOf(db, row!.id) };
    });

    expect(changedRows(outcome)).toBe(true);
    expect(item).toEqual({ unitPrice: 4, totalPrice: 8, quantity: 2 });
  });

  it('does not let an admin add, change or remove an item of any order', async () => {
    const { added, changed, removal } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, owner.id, [[product.id, 1]]);
      const [item] = await itemsOf(db, orderId);
      await db.as({ role: 'ADMIN', userId: admin.id });
      return {
        added: await db.attempt(
          `insert into cartlify.order_items ("orderId", "productId", quantity, "unitPrice", "totalPrice")
           values ($1, $2, 1, 0, 0) returning id`,
          orderId,
          cheap.id,
        ),
        changed: await db.attempt(
          'update cartlify.order_items set quantity = 5 where id = $1 returning id',
          item!.id,
        ),
        removal: await db.attempt(
          'delete from cartlify.order_items where id = $1 returning id',
          item!.id,
        ),
      };
    });

    expect(added.ok).toBe(false);
    expect(changedRows(changed)).toBe(false);
    expect(changedRows(removal)).toBe(false);
  });
});

describe('the stock of a product', () => {
  it.each(['GUEST', 'USER'] as const)(
    'does not let a %s change the stock or the reserve of a product',
    async (role) => {
      const { stock, reserve } = await inRolledBackTx(async (db) => {
        await db.as(
          role === 'GUEST' ? { role, guestId: randomUUID() } : { role, userId: owner.id },
        );
        return {
          stock: await db.attempt(
            'update cartlify.products set stock = 1000 where id = $1 returning id',
            product.id,
          ),
          reserve: await db.attempt(
            'update cartlify.products set "reservedStock" = 5 where id = $1 returning id',
            product.id,
          ),
        };
      });

      expect(changedRows(stock)).toBe(false);
      expect(changedRows(reserve)).toBe(false);
    },
  );

  // the stock is what the batches have left: a delivery and a write-off change it (stock.test.ts),
  // a write-off never takes what the waiting orders hold
  it('does not let an admin change the stock of a product with a plain update', async () => {
    const { lower, stock } = await inRolledBackTx(async (db) => {
      await waitingOrderOf(db, owner.id, [[product.id, 3]]);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const lower = await db.attempt(
        'update cartlify.products set stock = 5 where id = $1 returning id',
        product.id,
      );
      return { lower, stock: await stockOf(db, admin.id, product.id) };
    });

    expect(changedRows(lower)).toBe(false);
    expect(stock).toEqual({ stock: 10, reserved: 3 });
  });

  // the reserve is what the waiting orders hold; only their steps change it, or a later release
  // of a reservation finds less than it holds and fails
  it('does not let an admin change the reserve of a product directly', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await waitingOrderOf(db, owner.id, [[product.id, 3]]);
      await db.as({ role: 'ADMIN', userId: admin.id });
      return db.attempt(
        'update cartlify.products set "reservedStock" = 5 where id = $1 returning id',
        product.id,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });
});

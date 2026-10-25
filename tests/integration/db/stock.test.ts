import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor } from '../../helpers/db.js';
import {
  cartOf,
  confirm,
  orderStateOf,
  pay,
  stockOf,
  waitingOrderOf,
} from '../../helpers/dbOrders.js';
import {
  allocationsOf,
  batchesOf,
  batchIdOf,
  checkDeferredNow,
  dayAfter,
  expiredUnitsOf,
  fieldOf,
  receive,
  setShopDay,
  stockLinesOf,
  utcDay,
  writeOff,
} from '../../helpers/dbStock.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the stock of a product is what its batches have left. A batch comes in through
// cartlify.receive_product_batch, units go out through cartlify.write_off_product_stock and
// through the payment of an order, which keeps what it took from each batch
// (order_batch_allocations); a cancel of the paid order puts the units back into the same
// batches. Each of these functions acts as the owner for a signed-in admin, the admin log keeps
// the line in their name. A plain statement changes none of it

let owner: TestUser;
let admin: TestUser;
let root: TestUser;
// products without stock: each test takes in its own batches, rolled back after it
let product: TestProduct;
let other: TestProduct;
let removed: TestProduct;

beforeAll(async () => {
  owner = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ price: 10, stock: 0 });
  other = await createProduct({ price: 4, stock: 0 });
  removed = await createProduct({ price: 7, stock: 0 });
  await deleteProductFromCatalog(removed.id);
});

afterAll(async () => {
  try {
    await closeSessions([owner.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });
// the system: the admin context without a user id, the way setAdminContext sets it
const asSystem = (): Actor => ({ role: 'ADMIN' });

describe('cartlify.receive_product_batch', () => {
  it('takes in a batch: the stock grows by it, the batch keeps its cost, number and end', async () => {
    const { batchId, batches, stock, check } = await inRolledBackTx(async (db) => {
      const batchId = await batchIdOf(db, asAdmin(), product.id, {
        quantity: 7,
        unitCost: '3.25',
        expiresAt: utcDay(30),
        supplierBatchNumber: '  LOT-42  ',
      });
      return {
        batchId,
        batches: await batchesOf(db, admin.id, product.id),
        stock: await stockOf(db, admin.id, product.id),
        check: await checkDeferredNow(db),
      };
    });

    expect(batches).toEqual([
      {
        id: batchId,
        source: 'supplier',
        supplierBatchNumber: 'LOT-42',
        unitCost: '3.25',
        quantity: 7,
        remaining: 7,
        expiresAt: utcDay(30),
      },
    ]);
    expect(stock).toEqual({ stock: 7, reserved: 0 });
    expect(check.ok).toBe(true);
  });

  it('keeps the line of the delivery in the admin log in the name of the admin', async () => {
    const deliveryId = randomUUID();

    const { batchId, lines } = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { quantity: 2 });
      const batchId = await batchIdOf(db, asAdmin(), product.id, {
        deliveryId,
        quantity: 3,
        unitCost: '1.50',
        supplier: ' Acme ',
        document: 'INV-7',
        note: 'Second box',
      });
      return { batchId, lines: await stockLinesOf(db, admin.id, product.id, 'STOCK_DELIVERY') };
    });

    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      actorId: admin.id,
      actorRole: 'ADMIN',
      meta: [
        { field: 'stock', old: 2, new: 5 },
        {
          field: 'batch',
          old: null,
          new: {
            id: batchId,
            source: 'supplier',
            quantity: 3,
            unitCost: '1.5',
            expiresAt: null,
            supplierBatchNumber: null,
          },
        },
        { field: 'delivery', old: null, new: deliveryId },
        { field: 'supplier', old: null, new: 'Acme' },
        { field: 'document', old: null, new: 'INV-7' },
        { field: 'note', old: null, new: 'Second box' },
      ],
    });
  });

  it('leaves the empty texts out of the line', async () => {
    const lines = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { supplier: '  ', document: '', note: null });
      return stockLinesOf(db, admin.id, product.id, 'STOCK_DELIVERY');
    });

    expect(lines[0]!.meta.map((change) => change.field)).toEqual(['stock', 'batch', 'delivery']);
  });

  it.each(['surplus', 'customer_return'])('takes in a batch of %s', async (source) => {
    const batches = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { source, unitCost: '0' });
      return batchesOf(db, admin.id, product.id);
    });

    expect(batches).toEqual([expect.objectContaining({ source, unitCost: '0.00' })]);
  });

  it('takes in a batch that is good until today', async () => {
    const outcome = await inRolledBackTx((db) =>
      receive(db, asAdmin(), product.id, { expiresAt: utcDay(0) }),
    );

    expect(outcome.ok).toBe(true);
  });

  it('lets root take in a batch too', async () => {
    const outcome = await inRolledBackTx((db) =>
      receive(db, { role: 'ROOT', userId: root.id }, product.id),
    );

    expect(outcome.ok).toBe(true);
  });

  it.each([
    ['no units', { quantity: 0 }, 'BATCH_QUANTITY_INVALID'],
    ['fewer than no units', { quantity: -1 }, 'BATCH_QUANTITY_INVALID'],
    ['a cost below zero', { unitCost: '-0.01' }, 'BATCH_UNIT_COST_INVALID'],
    ['a cost finer than a cent', { unitCost: '1.555' }, 'BATCH_UNIT_COST_INVALID'],
    ['an end that is over', { expiresAt: utcDay(-1) }, 'BATCH_EXPIRES_AT_INVALID'],
    ['a supplier name over 200 characters', { supplier: 'x'.repeat(201) }, 'STOCK_TEXT_TOO_LONG'],
    ['an invoice over 100 characters', { document: 'x'.repeat(101) }, 'STOCK_TEXT_TOO_LONG'],
    ['a note over 500 characters', { note: 'x'.repeat(501) }, 'STOCK_TEXT_TOO_LONG'],
  ])('refuses a batch with %s and changes nothing', async (_case, args, error) => {
    const { outcome, batches, stock } = await inRolledBackTx(async (db) => {
      const outcome = await receive(db, asAdmin(), product.id, args);
      return {
        outcome,
        batches: await batchesOf(db, admin.id, product.id),
        stock: await stockOf(db, admin.id, product.id),
      };
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(error) });
    expect(batches).toEqual([]);
    expect(stock).toEqual({ stock: 0, reserved: 0 });
  });

  it('refuses a number of the supplier over 100 characters', async () => {
    const outcome = await inRolledBackTx((db) =>
      receive(db, asAdmin(), product.id, { supplierBatchNumber: 'x'.repeat(101) }),
    );

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it.each([
    ['a product removed from the catalog', () => removed.id],
    ['a product that does not exist', () => 2_000_000_000],
  ])('refuses %s', async (_case, productId) => {
    const outcome = await inRolledBackTx((db) => receive(db, asAdmin(), productId()));

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('PRODUCT_NOT_FOUND'),
    });
  });

  // the line of the log needs the admin who took the batch in
  it.each([
    ['the system', () => asSystem()],
    ['a user', (): Actor => ({ role: 'USER', userId: owner.id })],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])('refuses %s', async (_who, actor) => {
    const outcome = await inRolledBackTx((db) => receive(db, actor(), product.id));

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('STOCK_RECEIVE_FORBIDDEN'),
    });
  });
});

describe('cartlify.write_off_product_stock', () => {
  it('writes off units of the batch an admin names, the line keeps the reason and the cost', async () => {
    const writeOffId = randomUUID();

    const { first, second, outcome, batches, stock, lines, check } = await inRolledBackTx(
      async (db) => {
        const first = await batchIdOf(db, asAdmin(), product.id, { quantity: 4, unitCost: '2' });
        const second = await batchIdOf(db, asAdmin(), product.id, { quantity: 5, unitCost: '3' });
        const outcome = await writeOff(db, asAdmin(), product.id, {
          writeOffId,
          batchId: second,
          quantity: 2,
          reason: 'damaged',
          note: ' Wet box ',
        });
        return {
          first,
          second,
          outcome,
          batches: await batchesOf(db, admin.id, product.id),
          stock: await stockOf(db, admin.id, product.id),
          lines: await stockLinesOf(db, admin.id, product.id, 'STOCK_WRITE_OFF'),
          check: await checkDeferredNow(db),
        };
      },
    );

    const taken = [{ batchId: second, quantity: 2, unitCost: '3' }];
    expect(outcome).toEqual({ ok: true, rows: [{ taken }] });
    expect(batches.map((b) => [b.id, b.remaining])).toEqual([
      [first, 4],
      [second, 3],
    ]);
    expect(stock).toEqual({ stock: 7, reserved: 0 });
    expect(lines).toEqual([
      {
        actorId: admin.id,
        actorRole: 'ADMIN',
        meta: [
          { field: 'stock', old: 9, new: 7 },
          { field: 'reason', old: null, new: 'damaged' },
          { field: 'batches', old: null, new: taken },
          { field: 'writeOff', old: null, new: writeOffId },
          { field: 'note', old: null, new: 'Wet box' },
        ],
      },
    ]);
    expect(check.ok).toBe(true);
  });

  // the way a sale takes them: the batch that ends first, then the ones without an end, oldest first
  it('writes off from the batches in the order a sale takes them when no batch is named', async () => {
    const { ids, outcome, batches } = await inRolledBackTx(async (db) => {
      const ids = {
        noEndOld: await batchIdOf(db, asAdmin(), product.id, { quantity: 2, unitCost: '1' }),
        late: await batchIdOf(db, asAdmin(), product.id, {
          quantity: 2,
          unitCost: '2',
          expiresAt: utcDay(60),
        }),
        soon: await batchIdOf(db, asAdmin(), product.id, {
          quantity: 2,
          unitCost: '3',
          expiresAt: utcDay(5),
        }),
        noEndNew: await batchIdOf(db, asAdmin(), product.id, { quantity: 2, unitCost: '4' }),
      };
      const outcome = await writeOff(db, asAdmin(), product.id, {
        quantity: 7,
        reason: 'shortage',
      });
      return { ids, outcome, batches: await batchesOf(db, admin.id, product.id) };
    });

    expect(outcome.ok && outcome.rows[0]!.taken).toEqual([
      { batchId: ids.soon, quantity: 2, unitCost: '3' },
      { batchId: ids.late, quantity: 2, unitCost: '2' },
      { batchId: ids.noEndOld, quantity: 2, unitCost: '1' },
      { batchId: ids.noEndNew, quantity: 1, unitCost: '4' },
    ]);
    expect(batches.map((b) => b.remaining)).toEqual([0, 0, 0, 1]);
  });

  it('keeps the units the waiting orders hold and changes nothing', async () => {
    const { outcome, stock } = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { quantity: 5 });
      await waitingOrderOf(db, owner.id, [[product.id, 3]]);
      const outcome = await writeOff(db, asAdmin(), product.id, { quantity: 3 });
      return { outcome, stock: await stockOf(db, admin.id, product.id) };
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('INSUFFICIENT_AVAILABLE_STOCK'),
    });
    expect(stock).toEqual({ stock: 5, reserved: 3 });
  });

  it('refuses more than the batch named has left', async () => {
    const { outcome, batches } = await inRolledBackTx(async (db) => {
      const small = await batchIdOf(db, asAdmin(), product.id, { quantity: 1 });
      await batchIdOf(db, asAdmin(), product.id, { quantity: 5 });
      const outcome = await writeOff(db, asAdmin(), product.id, { batchId: small, quantity: 2 });
      return { outcome, batches: await batchesOf(db, admin.id, product.id) };
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('BATCH_INSUFFICIENT'),
    });
    expect(batches.map((b) => b.remaining)).toEqual([1, 5]);
  });

  it('refuses a batch of another product', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { quantity: 5 });
      const foreign = await batchIdOf(db, asAdmin(), other.id, { quantity: 5 });
      return writeOff(db, asAdmin(), product.id, { batchId: foreign, quantity: 1 });
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('BATCH_NOT_FOUND'),
    });
  });

  it('writes off what a product removed from the catalog has left', async () => {
    const { outcome, stock } = await inRolledBackTx(async (db) => {
      // the batch came before the product left the catalog
      await db.as(asAdmin());
      await db.rows(
        'update cartlify.products set "deletedAt" = null where id = $1 returning id',
        removed.id,
      );
      await batchIdOf(db, asAdmin(), removed.id, { quantity: 3 });
      await db.rows(
        'update cartlify.products set "deletedAt" = now() where id = $1 returning id',
        removed.id,
      );
      const outcome = await writeOff(db, asAdmin(), removed.id, { quantity: 3 });
      return { outcome, stock: await stockOf(db, admin.id, removed.id) };
    });

    expect(outcome.ok).toBe(true);
    expect(stock).toEqual({ stock: 0, reserved: 0 });
  });

  it.each(['damaged', 'defective', 'expired', 'shortage', 'returned_to_supplier'])(
    'takes the reason %s',
    async (reason) => {
      const outcome = await inRolledBackTx(async (db) => {
        await batchIdOf(db, asAdmin(), product.id, { quantity: 1 });
        return writeOff(db, asAdmin(), product.id, { reason });
      });

      expect(outcome.ok).toBe(true);
    },
  );

  it('takes the reason other with a note that says what it is', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { quantity: 1 });
      return writeOff(db, asAdmin(), product.id, { reason: 'other', note: 'Sample for a blogger' });
    });

    expect(outcome.ok).toBe(true);
  });

  it.each([
    ['an unknown reason', { reason: 'stolen' }, 'WRITE_OFF_REASON_INVALID'],
    ['the reason other without a note', { reason: 'other', note: '  ' }, 'WRITE_OFF_NOTE_REQUIRED'],
    ['no units', { quantity: 0 }, 'WRITE_OFF_QUANTITY_INVALID'],
    ['a note over 500 characters', { note: 'x'.repeat(501) }, 'STOCK_TEXT_TOO_LONG'],
  ])('refuses %s', async (_case, args, error) => {
    const outcome = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { quantity: 1 });
      return writeOff(db, asAdmin(), product.id, args);
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(error) });
  });

  it.each([
    ['the system', () => asSystem()],
    ['a user', (): Actor => ({ role: 'USER', userId: owner.id })],
  ])('refuses %s', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { quantity: 1 });
      return writeOff(db, actor(), product.id);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('STOCK_WRITE_OFF_FORBIDDEN'),
    });
  });
});

describe('a sale takes from the batches', () => {
  it('takes the units of a paid order from the batch that ends first and keeps what it took', async () => {
    const { late, soon, orderId, allocations, batches, stock, check } = await inRolledBackTx(
      async (db) => {
        const late = await batchIdOf(db, asAdmin(), product.id, {
          quantity: 3,
          expiresAt: utcDay(60),
        });
        const soon = await batchIdOf(db, asAdmin(), product.id, {
          quantity: 2,
          expiresAt: utcDay(5),
        });
        const orderId = await waitingOrderOf(db, owner.id, [[product.id, 3]]);
        const result = await pay(db, admin.id, orderId);
        if (result !== 'PAID') throw new Error(`pay_order answered ${result}`);
        return {
          late,
          soon,
          orderId,
          allocations: await allocationsOf(db, admin.id, orderId),
          batches: await batchesOf(db, admin.id, product.id),
          stock: await stockOf(db, admin.id, product.id),
          check: await checkDeferredNow(db),
        };
      },
    );

    expect(orderId).toEqual(expect.any(Number));
    expect(allocations).toEqual([
      { productId: product.id, batchId: late, quantity: 1 },
      { productId: product.id, batchId: soon, quantity: 2 },
    ]);
    expect(batches.map((b) => [b.id, b.remaining])).toEqual([
      [late, 2],
      [soon, 0],
    ]);
    expect(stock).toEqual({ stock: 2, reserved: 0 });
    expect(check.ok).toBe(true);
  });

  it('keeps what an order of several products took from each of them', async () => {
    const allocations = await inRolledBackTx(async (db) => {
      const mine = await batchIdOf(db, asAdmin(), product.id, { quantity: 5 });
      const theirs = await batchIdOf(db, asAdmin(), other.id, { quantity: 5 });
      const orderId = await waitingOrderOf(db, owner.id, [
        [product.id, 2],
        [other.id, 1],
      ]);
      await pay(db, admin.id, orderId);
      return { mine, theirs, rows: await allocationsOf(db, admin.id, orderId) };
    });

    expect(allocations.rows).toEqual([
      { productId: product.id, batchId: allocations.mine, quantity: 2 },
      { productId: other.id, batchId: allocations.theirs, quantity: 1 },
    ]);
  });

  it('takes a late payment from the batches too', async () => {
    const { batchId, allocations } = await inRolledBackTx(async (db) => {
      const batchId = await batchIdOf(db, asAdmin(), product.id, { quantity: 5 });
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      await db.as(asSystem());
      await db.rows('select 1 as done from cartlify.unconfirm_order($1::int)', orderId);
      const result = await pay(db, admin.id, orderId);
      if (result !== 'PAID') throw new Error(`pay_order answered ${result}`);
      return { batchId, allocations: await allocationsOf(db, admin.id, orderId) };
    });

    expect(allocations).toEqual([{ productId: product.id, batchId, quantity: 2 }]);
  });

  it('puts the units of a cancelled paid order back into the batches they came from', async () => {
    const { late, soon, allocations, batches, stock, check } = await inRolledBackTx(async (db) => {
      const late = await batchIdOf(db, asAdmin(), product.id, {
        quantity: 3,
        expiresAt: utcDay(60),
      });
      const soon = await batchIdOf(db, asAdmin(), product.id, {
        quantity: 2,
        expiresAt: utcDay(5),
      });
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 3]]);
      await pay(db, admin.id, orderId);
      // a later delivery does not take the units back
      await batchIdOf(db, asAdmin(), product.id, { quantity: 4 });
      await db.as(asAdmin());
      await db.rows('select 1 as done from cartlify.cancel_paid_order($1::int)', orderId);
      return {
        late,
        soon,
        allocations: await allocationsOf(db, admin.id, orderId),
        batches: await batchesOf(db, admin.id, product.id),
        stock: await stockOf(db, admin.id, product.id),
        check: await checkDeferredNow(db),
      };
    });

    // the lines stay for the reports: the cost of the cancelled sale goes back on its day
    expect(allocations).toEqual([
      { productId: product.id, batchId: late, quantity: 1 },
      { productId: product.id, batchId: soon, quantity: 2 },
    ]);
    expect(batches.map((b) => b.remaining)).toEqual([3, 2, 4]);
    expect(stock).toEqual({ stock: 9, reserved: 0 });
    expect(check.ok).toBe(true);
  });
});

describe('the stock and the batches under plain statements', () => {
  it('lets an admin create a product without stock only', async () => {
    const { empty, stocked } = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const insert = (stock: number) =>
        db.attempt(
          `insert into cartlify.products (name, price, stock, "categoryId", "updatedAt")
           values ('Boxed', 5, $2, $1, now()) returning id`,
          product.categoryId,
          stock,
        );
      return { empty: await insert(0), stocked: await insert(3) };
    });

    expect(empty.ok).toBe(true);
    expect(stocked.ok).toBe(false);
  });

  it('does not let an admin change the stock of a product, up or down', async () => {
    const { up, down, stock } = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { quantity: 5 });
      await db.as(asAdmin());
      const up = await db.attempt(
        'update cartlify.products set stock = 9 where id = $1 returning id',
        product.id,
      );
      const down = await db.attempt(
        'update cartlify.products set stock = 1 where id = $1 returning id',
        product.id,
      );
      return { up, down, stock: await stockOf(db, admin.id, product.id) };
    });

    expect(up.ok).toBe(false);
    expect(down.ok).toBe(false);
    expect(stock).toEqual({ stock: 5, reserved: 0 });
  });

  it.each([
    [
      'take in a batch with a plain insert',
      `insert into cartlify.product_batches
         ("productId", "deliveryId", source, "unitCost", quantity, remaining)
       values ($1, gen_random_uuid(), 'supplier', 1, 5, 5) returning id`,
    ],
    [
      'change what a batch has left',
      'update cartlify.product_batches set remaining = 0 where "productId" = $1 returning id',
    ],
    [
      'change the cost of a batch',
      'update cartlify.product_batches set "unitCost" = 0 where "productId" = $1 returning id',
    ],
    ['delete a batch', 'delete from cartlify.product_batches where "productId" = $1 returning id'],
  ])('does not let an admin %s', async (_case, statement) => {
    const { outcome, batches } = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { quantity: 5, unitCost: '2' });
      await db.as(asAdmin());
      const outcome = await db.attempt(statement, product.id);
      return { outcome, batches: await batchesOf(db, admin.id, product.id) };
    });

    expect(outcome.ok && outcome.rows.length > 0).toBe(false);
    expect(batches).toEqual([expect.objectContaining({ remaining: 5, unitCost: '2.00' })]);
  });

  it.each([
    [
      'change what an order took',
      'update cartlify.order_batch_allocations set quantity = 1 where "orderId" = $1 returning id',
    ],
    [
      'delete what an order took',
      'delete from cartlify.order_batch_allocations where "orderId" = $1 returning id',
    ],
  ])('does not let an admin %s', async (_case, statement) => {
    const { outcome, allocations } = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { quantity: 5 });
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      await pay(db, admin.id, orderId);
      await db.as(asAdmin());
      const outcome = await db.attempt(statement, orderId);
      return { outcome, allocations: await allocationsOf(db, admin.id, orderId) };
    });

    expect(outcome.ok && outcome.rows.length > 0).toBe(false);
    expect(allocations).toEqual([expect.objectContaining({ quantity: 2 })]);
  });

  it.each([
    ['a user', (): Actor => ({ role: 'USER', userId: owner.id })],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])('shows %s no batch and nothing an order took', async (_who, actor) => {
    const seen = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { quantity: 5 });
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 1]]);
      await pay(db, admin.id, orderId);
      await db.as(actor());
      return {
        batches: await db.rows(
          'select id from cartlify.product_batches where "productId" = $1',
          product.id,
        ),
        allocations: await db.rows(
          'select id from cartlify.order_batch_allocations where "orderId" = $1',
          orderId,
        ),
      };
    });

    expect(seen).toEqual({ batches: [], allocations: [] });
  });

  it('keeps the line of a write-off with the cost of each batch', async () => {
    const line = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.id, { quantity: 2, unitCost: '1.10' });
      await writeOff(db, asAdmin(), product.id, { quantity: 1, reason: 'expired' });
      return (await stockLinesOf(db, admin.id, product.id, 'STOCK_WRITE_OFF'))[0];
    });

    expect(fieldOf(line, 'batches')).toEqual([expect.objectContaining({ unitCost: '1.1' })]);
  });
});

// the day of the shop goes with the context of the app (cartlify.shop_today); a batch whose last
// good day is before it is over: its units are no free units, a sale never takes them, a
// write-off takes them first
describe('a batch that is over', () => {
  const DAY = '2030-06-10';

  it('takes the day of utc when the app sets no day, and the day it sets', async () => {
    const days = await inRolledBackTx(async (db) => {
      const [before] = await db.rows<{ day: string; utc: string }>(
        `select cartlify.shop_today()::text as day, (now() at time zone 'UTC')::date::text as utc`,
      );
      await setShopDay(db, DAY);
      const [after] = await db.rows<{ day: string }>('select cartlify.shop_today()::text as day');
      return { before: before!, after: after! };
    });

    expect(days.before.day).toBe(days.before.utc);
    expect(days.after.day).toBe(DAY);
  });

  it('counts the units of the batches that are over, until the last good day they are good', async () => {
    const counted = await inRolledBackTx(async (db) => {
      await setShopDay(db, DAY);
      await batchIdOf(db, asAdmin(), product.id, { quantity: 3, expiresAt: DAY });
      await batchIdOf(db, asAdmin(), product.id, { quantity: 4, expiresAt: dayAfter(DAY, 5) });
      await batchIdOf(db, asAdmin(), product.id, { quantity: 2 });
      const onTheDay = await expiredUnitsOf(db, product.id);
      await setShopDay(db, dayAfter(DAY));
      return { onTheDay, dayAfter: await expiredUnitsOf(db, product.id) };
    });

    expect(counted).toEqual({ onTheDay: 0, dayAfter: 3 });
  });

  it('takes in a batch good until the day of the shop, not one that is over by it', async () => {
    const { today, yesterday } = await inRolledBackTx(async (db) => {
      await setShopDay(db, DAY);
      return {
        today: await receive(db, asAdmin(), product.id, { expiresAt: DAY }),
        yesterday: await receive(db, asAdmin(), product.id, { expiresAt: dayAfter(DAY, -1) }),
      };
    });

    expect(today.ok).toBe(true);
    expect(yesterday).toMatchObject({
      ok: false,
      message: expect.stringContaining('BATCH_EXPIRES_AT_INVALID'),
    });
  });

  // the reserve of a waiting order is of good units only: a write-off of the good batch by its
  // name would leave the reserve on units that are over, and the payment of the order in time
  // would find no good batch and give the money back
  it('refuses to write off a good batch the reserve of a waiting order needs', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await setShopDay(db, DAY);
      await batchIdOf(db, asAdmin(), product.id, { quantity: 5, expiresAt: DAY });
      const good = await batchIdOf(db, asAdmin(), product.id, { quantity: 5 });
      await setShopDay(db, dayAfter(DAY));
      await waitingOrderOf(db, owner.id, [[product.id, 5]]);
      return writeOff(db, asAdmin(), product.id, { batchId: good, quantity: 5 });
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('INSUFFICIENT_AVAILABLE_STOCK'),
    });
  });

  it('writes off a batch that is over while a waiting order holds the good units', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await setShopDay(db, DAY);
      const over = await batchIdOf(db, asAdmin(), product.id, { quantity: 5, expiresAt: DAY });
      await batchIdOf(db, asAdmin(), product.id, { quantity: 5 });
      await setShopDay(db, dayAfter(DAY));
      await waitingOrderOf(db, owner.id, [[product.id, 5]]);
      return writeOff(db, asAdmin(), product.id, { batchId: over, quantity: 5, reason: 'expired' });
    });

    expect(outcome.ok).toBe(true);
  });

  it('does not reserve the units of a batch that is over', async () => {
    const { outcome, stock } = await inRolledBackTx(async (db) => {
      await setShopDay(db, DAY);
      await batchIdOf(db, asAdmin(), product.id, { quantity: 3, expiresAt: DAY });
      await batchIdOf(db, asAdmin(), product.id, { quantity: 1 });
      const orderId = await cartOf(db, owner.id, [[product.id, 2]]);
      await setShopDay(db, dayAfter(DAY));
      return {
        outcome: await confirm(db, owner.id, orderId),
        stock: await stockOf(db, admin.id, product.id),
      };
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('INSUFFICIENT_AVAILABLE_STOCK'),
    });
    expect(stock).toEqual({ stock: 4, reserved: 0 });
  });

  it('sells the good batches of a payment and leaves the ones that are over', async () => {
    const { good, allocations } = await inRolledBackTx(async (db) => {
      await setShopDay(db, DAY);
      await batchIdOf(db, asAdmin(), product.id, { quantity: 3, expiresAt: dayAfter(DAY, 1) });
      const good = await batchIdOf(db, asAdmin(), product.id, { quantity: 3 });
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      // the first batch is over by the payment, the good one gives the units
      await setShopDay(db, dayAfter(DAY, 2));
      const result = await pay(db, admin.id, orderId);
      if (result !== 'PAID') throw new Error(`pay_order answered ${result}`);
      return { good, allocations: await allocationsOf(db, admin.id, orderId) };
    });

    expect(allocations).toEqual([{ productId: product.id, batchId: good, quantity: 2 }]);
  });

  // the units were held while they were good; what is over is never sold, the money goes back
  it('refuses a payment of held units whose batch is over since, and changes nothing', async () => {
    const { result, state, stock, allocations } = await inRolledBackTx(async (db) => {
      await setShopDay(db, DAY);
      await batchIdOf(db, asAdmin(), product.id, { quantity: 3, expiresAt: DAY });
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      await setShopDay(db, dayAfter(DAY));
      const result = await pay(db, admin.id, orderId);
      return {
        result,
        state: await orderStateOf(db, admin.id, orderId),
        stock: await stockOf(db, admin.id, product.id),
        allocations: await allocationsOf(db, admin.id, orderId),
      };
    });

    expect(result).toBe('OUT_OF_STOCK');
    expect(state).toMatchObject({ status: 'waiting', paymentId: null });
    expect(stock).toEqual({ stock: 3, reserved: 2 });
    expect(allocations).toEqual([]);
  });

  it('refuses a late payment when only units that are over are there', async () => {
    const result = await inRolledBackTx(async (db) => {
      await setShopDay(db, DAY);
      await batchIdOf(db, asAdmin(), product.id, { quantity: 3, expiresAt: DAY });
      const orderId = await waitingOrderOf(db, owner.id, [[product.id, 2]]);
      await db.as(asSystem());
      await db.rows('select 1 as done from cartlify.unconfirm_order($1::int)', orderId);
      await setShopDay(db, dayAfter(DAY));
      return pay(db, admin.id, orderId);
    });

    expect(result).toBe('OUT_OF_STOCK');
  });

  it('writes off the units of a batch that is over first', async () => {
    const { over, taken } = await inRolledBackTx(async (db) => {
      await setShopDay(db, DAY);
      await batchIdOf(db, asAdmin(), product.id, { quantity: 2 });
      const over = await batchIdOf(db, asAdmin(), product.id, { quantity: 2, expiresAt: DAY });
      await setShopDay(db, dayAfter(DAY));
      const outcome = await writeOff(db, asAdmin(), product.id, { quantity: 2, reason: 'expired' });
      return { over, taken: outcome.ok ? outcome.rows[0]!.taken : outcome };
    });

    expect(taken).toEqual([{ batchId: over, quantity: 2, unitCost: '2.5' }]);
  });
});

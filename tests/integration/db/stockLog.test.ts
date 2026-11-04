import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import pg from 'pg';

import { prisma } from '@db/client.js';
import { STOCK_LOG_EVENTS } from '@config/journalEvents.js';

import { SHOP_CANCEL_SQL } from '../../helpers/cancel.js';
import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import {
  cartOf,
  confirm,
  orderStateOf,
  pay,
  stockOf,
  waitingOrderOf,
} from '../../helpers/dbOrders.js';
import {
  adminStockLinesOf,
  batchIdOf,
  dayAfter,
  fieldOf,
  setShopDay,
  stockLogOf,
  stockLogOfOperation,
  writeOff,
} from '../../helpers/dbStock.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the stock log is the journal of every change of the quantity of a variant (product_variants
// stock): a line for each variant for each change, with the event that made it (a delivery, a
// write-off, a sale at the payment of an order, the units back with a statement of return, which is
// what the cancel of a paid order is). The functions of the database that move the stock write the
// lines in the same transaction; nobody else writes, edits or deletes one; only admin and root
// read. A reserve and its release do not change the stock and have no line

let owner: TestUser;
let admin: TestUser;
let root: TestUser;
// products without stock: each test takes in its own batches, rolled back after it
let product: TestProduct;
// a second variant of the product, and another product with its own variant
let sibling: { id: number; productId: number };
let other: TestProduct;

beforeAll(async () => {
  owner = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ price: 10, stock: 0 });
  sibling = await createVariant(product.id, { price: 12, stock: 0 });
  other = await createProduct({ price: 4, stock: 0 });
});

afterAll(async () => {
  try {
    await closeSessions([owner.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });
const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });
// the system: the admin context without a user id, the way setAdminContext sets it
const asSystem = (): Actor => ({ role: 'ADMIN' });

// a waiting order of the owner for one unit of each variant, paid the way the webhook pays it
async function paidOrder(db: DbSession, items: [number, number][]) {
  const orderId = await waitingOrderOf(db, owner.id, items);
  const result = await pay(db, admin.id, orderId);
  if (result !== 'PAID') throw new Error(`pay_order answered ${result}`);
  return orderId;
}

// the cancel of a paid order: a statement of return for all of it with the reason shop_cancel,
// made by the actor given (an admin, root; the others are refused)
const cancel = async (db: DbSession, actor: Actor, orderId: number) => {
  await db.as(actor);
  return db.attempt(SHOP_CANCEL_SQL, orderId);
};

// the lines of the log of an order with the row of the statement each one names and the order and
// the variant of the item that row is for
const returnRowsOf = async (db: DbSession, orderId: number) => {
  await db.as(asAdmin());
  return db.rows<{
    event: string;
    variantId: number;
    returnItemId: number | null;
    itemOrderId: number | null;
    itemVariantId: number | null;
  }>(
    `select l.event, l."variantId", l."returnItemId",
            oi."orderId" as "itemOrderId", oi."variantId" as "itemVariantId"
     from cartlify.stock_log as l
     left join cartlify.return_items as ri on ri.id = l."returnItemId"
     left join cartlify.order_items as oi on oi.id = ri."orderItemId"
     where l."orderId" = $1
     order by l.id`,
    orderId,
  );
};

const countOf = async (db: DbSession, variantIds: number[]) => {
  await db.as(asAdmin());
  const [row] = await db.rows<{ n: number }>(
    'select count(*)::int as n from cartlify.stock_log where "variantId" = any($1::int[])',
    variantIds,
  );
  return row!.n;
};

describe('the stock log of a delivery', () => {
  it('has a line for each variant of the delivery, all of them with its id', async () => {
    const deliveryId = randomUUID();

    const { batches, lines } = await inRolledBackTx(async (db) => {
      const batches = [
        await batchIdOf(db, asAdmin(), product.variantId, { deliveryId, quantity: 3 }),
        await batchIdOf(db, asAdmin(), sibling.id, { deliveryId, quantity: 4, unitCost: '1.25' }),
        await batchIdOf(db, asAdmin(), other.variantId, { deliveryId, quantity: 5 }),
        // another delivery at the same time is not this one
        await batchIdOf(db, asAdmin(), other.variantId, { quantity: 1 }),
      ];
      return { batches, lines: await stockLogOfOperation(db, admin.id, 'deliveryId', deliveryId) };
    });

    expect(lines).toHaveLength(3);
    expect(lines.map((line) => [line.productId, line.variantId])).toEqual([
      [product.id, product.variantId],
      [product.id, sibling.id],
      [other.id, other.variantId],
    ]);
    expect(lines.map((line) => [line.event, line.quantityChange, line.stockAfter])).toEqual([
      ['stock.delivery', 3, 3],
      ['stock.delivery', 4, 4],
      ['stock.delivery', 5, 5],
    ]);
    expect(lines.every((line) => line.actorId === admin.id && line.actorRole === 'ADMIN')).toBe(
      true,
    );
    expect(lines.every((line) => line.writeOffId === null && line.orderId === null)).toBe(true);
    expect(fieldOf(lines[1], 'batches')).toEqual([
      { batchId: batches[1], quantity: 4, unitCost: '1.25' },
    ]);
  });

  it('has a line for each batch of one variant, the stock after each', async () => {
    const deliveryId = randomUUID();

    const lines = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { deliveryId, quantity: 2 });
      await batchIdOf(db, asAdmin(), product.variantId, { deliveryId, quantity: 3 });
      return stockLogOf(db, admin.id, product.variantId);
    });

    expect(lines.map((line) => [line.quantityChange, line.stockAfter, line.deliveryId])).toEqual([
      [2, 2, deliveryId],
      [3, 5, deliveryId],
    ]);
  });

  it('names root with the role of root', async () => {
    const [line] = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asRoot(), product.variantId, { quantity: 2 });
      return stockLogOf(db, root.id, product.variantId);
    });

    expect(line).toMatchObject({ actorId: root.id, actorRole: 'ROOT', quantityChange: 2 });
  });

  it('leaves no line when the database refuses the batch', async () => {
    const count = await inRolledBackTx(async (db) => {
      const refused = await db.attempt(
        `select cartlify.receive_variant_batch(gen_random_uuid(), $1::int,
           'supplier'::cartlify."StockSource", 0, 1, null, null, null, null, null)`,
        product.variantId,
      );
      expect(refused.ok).toBe(false);
      return countOf(db, [product.variantId]);
    });

    expect(count).toBe(0);
  });

  it('is not written for the admin log by the database: the server writes one line for the delivery', async () => {
    const lines = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 2 });
      return adminStockLinesOf(db, admin.id, product.variantId);
    });

    expect(lines).toEqual([]);
  });
});

describe('the stock log of a write-off', () => {
  it('has a line for each variant of the write-off, all of them with its id', async () => {
    const writeOffId = randomUUID();

    const { lines, stocks } = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 5, unitCost: '2' });
      await batchIdOf(db, asAdmin(), sibling.id, { quantity: 4, unitCost: '3' });
      await writeOff(db, asAdmin(), product.variantId, {
        writeOffId,
        quantity: 2,
        reason: 'damaged',
        note: 'Wet box',
      });
      await writeOff(db, asAdmin(), sibling.id, { writeOffId, quantity: 1, reason: 'damaged' });
      // another write-off is not this one
      await writeOff(db, asAdmin(), sibling.id, { quantity: 1, reason: 'shortage' });
      return {
        lines: await stockLogOfOperation(db, admin.id, 'writeOffId', writeOffId),
        stocks: [
          await stockOf(db, admin.id, product.variantId),
          await stockOf(db, admin.id, sibling.id),
        ],
      };
    });

    expect(lines).toHaveLength(2);
    expect(
      lines.map((line) => [line.variantId, line.event, line.quantityChange, line.stockAfter]),
    ).toEqual([
      [product.variantId, 'stock.write_off', -2, 3],
      [sibling.id, 'stock.write_off', -1, 3],
    ]);
    expect(lines.every((line) => line.actorId === admin.id && line.actorRole === 'ADMIN')).toBe(
      true,
    );
    expect(lines.every((line) => line.deliveryId === null && line.orderId === null)).toBe(true);
    expect(lines[0]!.meta!.map((change) => change.field)).toEqual(['reason', 'batches', 'note']);
    expect(fieldOf(lines[0], 'reason')).toBe('damaged');
    expect(fieldOf(lines[0], 'batches')).toEqual([
      { batchId: expect.any(Number), quantity: 2, unitCost: '2' },
    ]);
    expect(stocks).toEqual([
      { stock: 3, reserved: 0 },
      { stock: 2, reserved: 0 },
    ]);
  });

  it('keeps the batches with the costs of a write-off that took from several of them', async () => {
    const [line] = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 2, unitCost: '1' });
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 3, unitCost: '4' });
      await writeOff(db, asAdmin(), product.variantId, { quantity: 4, reason: 'expired' });
      return stockLogOf(db, admin.id, product.variantId, 'stock.write_off');
    });

    expect(fieldOf(line, 'batches')).toEqual([
      { batchId: expect.any(Number), quantity: 2, unitCost: '1' },
      { batchId: expect.any(Number), quantity: 2, unitCost: '4' },
    ]);
    expect(line).toMatchObject({ quantityChange: -4, stockAfter: 1 });
  });

  it('has the line of a variant an admin took out of sale', async () => {
    const lines = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), sibling.id, { quantity: 2 });
      await db.as(asAdmin());
      await db.rows(
        `update cartlify.product_variants set "deletedAt" = now() at time zone 'UTC'
         where id = $1 returning id`,
        sibling.id,
      );
      await writeOff(db, asAdmin(), sibling.id, { quantity: 2, reason: 'defective' });
      return stockLogOf(db, admin.id, sibling.id);
    });

    expect(lines.map((line) => [line.event, line.quantityChange, line.stockAfter])).toEqual([
      ['stock.delivery', 2, 2],
      ['stock.write_off', -2, 0],
    ]);
  });

  it('leaves no line when the database refuses the write-off', async () => {
    const count = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 2 });
      const before = await countOf(db, [product.variantId]);
      const refused = await writeOff(db, asAdmin(), product.variantId, {
        quantity: 3,
        reason: 'damaged',
      });
      expect(refused.ok).toBe(false);
      return (await countOf(db, [product.variantId])) - before;
    });

    expect(count).toBe(0);
  });

  it('is not written for the admin log by the database: the server writes one line for the write-off', async () => {
    const lines = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 2 });
      await writeOff(db, asAdmin(), product.variantId, { quantity: 1, reason: 'damaged' });
      return adminStockLinesOf(db, admin.id, product.variantId);
    });

    expect(lines).toEqual([]);
  });
});

describe('the stock log of a sale', () => {
  it('has a line for each variant of the order at its payment, with the order and without an actor', async () => {
    const { orderId, lines, batch } = await inRolledBackTx(async (db) => {
      const batch = await batchIdOf(db, asAdmin(), product.variantId, {
        quantity: 5,
        unitCost: '2.5',
      });
      await batchIdOf(db, asAdmin(), other.variantId, { quantity: 3, unitCost: '1' });
      const orderId = await paidOrder(db, [
        [product.variantId, 2],
        [other.variantId, 1],
      ]);
      return { orderId, batch, lines: await stockLogOfOperation(db, admin.id, 'orderId', orderId) };
    });

    expect(lines).toHaveLength(2);
    expect(
      lines.map((line) => [line.variantId, line.event, line.quantityChange, line.stockAfter]),
    ).toEqual([
      [product.variantId, 'stock.sale', -2, 3],
      [other.variantId, 'stock.sale', -1, 2],
    ]);
    expect(lines.every((line) => line.orderId === orderId)).toBe(true);
    // the payment is the work of the system: no admin did it
    expect(lines.every((line) => line.actorId === null && line.actorRole === null)).toBe(true);
    expect(lines.every((line) => line.deliveryId === null && line.writeOffId === null)).toBe(true);
    expect(fieldOf(lines[0], 'batches')).toEqual([
      { batchId: batch, quantity: 2, unitCost: '2.5' },
    ]);
  });

  it('keeps the batches a sale took the units from, the one that ends first before the others', async () => {
    const { late, soon, line } = await inRolledBackTx(async (db) => {
      const late = await batchIdOf(db, asAdmin(), product.variantId, {
        quantity: 3,
        unitCost: '3',
        expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10),
      });
      const soon = await batchIdOf(db, asAdmin(), product.variantId, {
        quantity: 2,
        unitCost: '2',
        expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
      });
      await paidOrder(db, [[product.variantId, 3]]);
      const [line] = await stockLogOf(db, admin.id, product.variantId, 'stock.sale');
      return { late, soon, line };
    });

    expect(fieldOf(line, 'batches')).toEqual([
      { batchId: soon, quantity: 2, unitCost: '2' },
      { batchId: late, quantity: 1, unitCost: '3' },
    ]);
  });

  it('has the lines of a late payment too, an order whose reservation had ended', async () => {
    const lines = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 5 });
      const orderId = await waitingOrderOf(db, owner.id, [[product.variantId, 2]]);
      await db.as(asSystem());
      await db.rows('select 1 as done from cartlify.unconfirm_order($1::int)', orderId);
      const result = await pay(db, admin.id, orderId);
      expect(result).toBe('PAID');
      return stockLogOfOperation(db, admin.id, 'orderId', orderId);
    });

    expect(lines.map((line) => [line.event, line.quantityChange, line.stockAfter])).toEqual([
      ['stock.sale', -2, 3],
    ]);
    expect(lines[0]!.actorId).toBeNull();
  });

  it('leaves no line of a variant when the payment is refused for another one of the order', async () => {
    const DAY = '2030-06-10';

    const { result, lines } = await inRolledBackTx(async (db) => {
      await setShopDay(db, DAY);
      // the first variant is good; the second one has units whose last good day passes before the
      // payment, so the payment is refused after the first variant was taken from
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 3 });
      await batchIdOf(db, asAdmin(), sibling.id, { quantity: 3, expiresAt: DAY });
      const orderId = await waitingOrderOf(db, owner.id, [
        [product.variantId, 1],
        [sibling.id, 1],
      ]);
      await setShopDay(db, dayAfter(DAY));
      const result = await pay(db, admin.id, orderId);
      return { result, lines: await stockLogOfOperation(db, admin.id, 'orderId', orderId) };
    });

    expect(result).toBe('OUT_OF_STOCK');
    expect(lines).toEqual([]);
  });

  it('has no line for an order that is only reserved, nor for the release of its units', async () => {
    const counts = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 5 });
      const before = await countOf(db, [product.variantId]);
      const orderId = await cartOf(db, owner.id, [[product.variantId, 2]]);
      const confirmed = await confirm(db, owner.id, orderId);
      expect(confirmed.ok).toBe(true);
      const reserved = await stockOf(db, admin.id, product.variantId);
      const whileReserved = await countOf(db, [product.variantId]);
      await db.as(asSystem());
      await db.rows('select 1 as done from cartlify.unconfirm_order($1::int)', orderId);
      return {
        reserved,
        released: await stockOf(db, admin.id, product.variantId),
        added: whileReserved - before,
        addedAfter: (await countOf(db, [product.variantId])) - before,
      };
    });

    expect(counts.reserved).toEqual({ stock: 5, reserved: 2 });
    expect(counts.released).toEqual({ stock: 5, reserved: 0 });
    expect(counts.added).toBe(0);
    expect(counts.addedAfter).toBe(0);
  });

  it('has no line for the end of the reservation of a waiting order', async () => {
    const { added, state } = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 5 });
      const before = await countOf(db, [product.variantId]);
      const orderId = await cartOf(db, owner.id, [[product.variantId, 2]]);
      await confirm(db, owner.id, orderId, '1 millisecond');
      await db.rows('select 1 as done from pg_sleep(0.05)');
      await db.as(asSystem());
      const expired = await db.rows<{ done: boolean }>(
        'select cartlify.expire_order_reservation($1::int) as done',
        orderId,
      );
      expect(expired[0]!.done).toBe(true);
      return {
        state: await orderStateOf(db, admin.id, orderId),
        added: (await countOf(db, [product.variantId])) - before,
      };
    });

    expect(state).toMatchObject({ status: 'unconfirmed', reserved: false });
    expect(added).toBe(0);
  });
});

describe('the stock log of a cancel', () => {
  it('has a line for each variant of the order with the units back, in the name of the admin', async () => {
    const { orderId, sold, back, rows } = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 5, unitCost: '2' });
      await batchIdOf(db, asAdmin(), other.variantId, { quantity: 3, unitCost: '1.5' });
      const orderId = await paidOrder(db, [
        [product.variantId, 2],
        [other.variantId, 1],
      ]);
      const cancelled = await cancel(db, asAdmin(), orderId);
      expect(cancelled.ok).toBe(true);
      const lines = await stockLogOfOperation(db, admin.id, 'orderId', orderId);
      return {
        orderId,
        sold: lines.filter((line) => line.event === 'stock.sale'),
        back: lines.filter((line) => line.event === 'stock.return'),
        rows: await returnRowsOf(db, orderId),
      };
    });

    expect(sold).toHaveLength(2);
    expect(back).toHaveLength(2);
    expect(
      back.map((line) => [line.variantId, line.quantityChange, line.stockAfter, line.orderId]),
    ).toEqual([
      [product.variantId, 2, 5, orderId],
      [other.variantId, 1, 3, orderId],
    ]);
    expect(back.every((line) => line.actorId === admin.id && line.actorRole === 'ADMIN')).toBe(
      true,
    );
    expect(back.every((line) => line.deliveryId === null && line.writeOffId === null)).toBe(true);
    // each line of the units back names the row of the statement it comes with (the item of this
    // order for the same variant), a row for each variant; the sale lines name none
    const backRows = rows.filter((row) => row.event === 'stock.return');
    expect(backRows).toHaveLength(2);
    expect(
      backRows.every(
        (row) =>
          row.returnItemId !== null &&
          row.itemOrderId === orderId &&
          row.itemVariantId === row.variantId,
      ),
    ).toBe(true);
    expect(new Set(backRows.map((row) => row.returnItemId)).size).toBe(2);
    expect(
      rows.filter((row) => row.event === 'stock.sale').every((row) => row.returnItemId === null),
    ).toBe(true);
    // the same batches with the same costs as the sale took them from
    expect(back.map((line) => fieldOf(line, 'batches'))).toEqual(
      sold.map((line) => fieldOf(line, 'batches')),
    );
  });

  it('names root when root cancels the order', async () => {
    const lines = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 3 });
      const orderId = await paidOrder(db, [[product.variantId, 1]]);
      await cancel(db, asRoot(), orderId);
      return stockLogOf(db, admin.id, product.variantId, 'stock.return');
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actorId: root.id, actorRole: 'ROOT', quantityChange: 1 });
  });

  it('puts back each batch it took from: a line holds them all', async () => {
    const { first, second, line } = await inRolledBackTx(async (db) => {
      const first = await batchIdOf(db, asAdmin(), product.variantId, {
        quantity: 1,
        unitCost: '1',
      });
      const second = await batchIdOf(db, asAdmin(), product.variantId, {
        quantity: 4,
        unitCost: '2',
      });
      const orderId = await paidOrder(db, [[product.variantId, 3]]);
      await cancel(db, asAdmin(), orderId);
      const [line] = await stockLogOf(db, admin.id, product.variantId, 'stock.return');
      return { first, second, line };
    });

    expect(fieldOf(line, 'batches')).toEqual([
      { batchId: first, quantity: 1, unitCost: '1' },
      { batchId: second, quantity: 2, unitCost: '2' },
    ]);
  });

  it('leaves no line when the cancel is refused', async () => {
    const added = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 3 });
      const orderId = await paidOrder(db, [[product.variantId, 1]]);
      const before = await countOf(db, [product.variantId]);
      // a signed-in buyer cannot cancel a paid order
      const refused = await cancel(db, { role: 'USER', userId: owner.id }, orderId);
      expect(refused).toMatchObject({ ok: false, message: 'RETURN_FORBIDDEN' });
      return (await countOf(db, [product.variantId])) - before;
    });

    expect(added).toBe(0);
  });
});

describe('the sum of the changes of a variant', () => {
  it('is its stock after a delivery, a sale, a write-off, a cancel and a delivery again', async () => {
    const { lines, stock } = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 5, unitCost: '2' });
      const sold = await paidOrder(db, [[product.variantId, 2]]);
      await writeOff(db, asAdmin(), product.variantId, { quantity: 1, reason: 'damaged' });
      const cancelled = await paidOrder(db, [[product.variantId, 1]]);
      await cancel(db, asAdmin(), cancelled);
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 3, unitCost: '3' });
      expect(sold).toBeGreaterThan(0);
      return {
        lines: await stockLogOf(db, admin.id, product.variantId),
        stock: await stockOf(db, admin.id, product.variantId),
      };
    });

    expect(lines.map((line) => [line.event, line.quantityChange, line.stockAfter])).toEqual([
      ['stock.delivery', 5, 5],
      ['stock.sale', -2, 3],
      ['stock.write_off', -1, 2],
      ['stock.sale', -1, 1],
      ['stock.return', 1, 2],
      ['stock.delivery', 3, 5],
    ]);
    expect(lines.reduce((sum, line) => sum + line.quantityChange, 0)).toBe(stock!.stock);
    expect(lines.at(-1)!.stockAfter).toBe(stock!.stock);
    // every line follows the one before it
    lines.reduce((after, line) => {
      expect(line.stockAfter).toBe(after + line.quantityChange);
      return line.stockAfter;
    }, 0);
  });

  it('holds for each variant of an order of several, as the changes of one do not touch the other', async () => {
    const results = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 4 });
      await batchIdOf(db, asAdmin(), sibling.id, { quantity: 6 });
      const orderId = await paidOrder(db, [
        [product.variantId, 3],
        [sibling.id, 2],
      ]);
      await writeOff(db, asAdmin(), sibling.id, { quantity: 1, reason: 'damaged' });
      await cancel(db, asAdmin(), orderId);

      const results = [];
      for (const variantId of [product.variantId, sibling.id]) {
        const lines = await stockLogOf(db, admin.id, variantId);
        results.push({
          sum: lines.reduce((sum, line) => sum + line.quantityChange, 0),
          last: lines.at(-1)!.stockAfter,
          stock: (await stockOf(db, admin.id, variantId))!.stock,
        });
      }
      return results;
    });

    expect(results).toEqual([
      { sum: 4, last: 4, stock: 4 },
      { sum: 5, last: 5, stock: 5 },
    ]);
  });
});

describe('the stock log is only added to', () => {
  const ACTORS: [string, () => Actor | null][] = [
    ['an admin', asAdmin],
    ['root', asRoot],
    ['the system', asSystem],
    ['a buyer', () => ({ role: 'USER', userId: owner.id })],
    ['a guest', () => ({ role: 'GUEST', guestId: randomUUID() })],
    ['nobody', () => null],
  ];

  it.each(ACTORS)(
    'lets %s neither write a line nor change or delete one',
    async (_who, actorOf) => {
      const outcomes = await inRolledBackTx(async (db) => {
        await batchIdOf(db, asAdmin(), product.variantId, { quantity: 2 });
        await db.as(actorOf());

        return [
          await db.attempt(
            `insert into cartlify.stock_log ("productId", "variantId", event, "quantityChange", "stockAfter")
           values ($1, $2, 'stock.delivery', 1, 3) returning id`,
            product.id,
            product.variantId,
          ),
          await db.attempt(
            `update cartlify.stock_log set "quantityChange" = 99 where "variantId" = $1 returning id`,
            product.variantId,
          ),
          await db.attempt(
            'delete from cartlify.stock_log where "variantId" = $1 returning id',
            product.variantId,
          ),
        ];
      });

      // the insert is refused; an update and a delete find no row they may touch
      expect(outcomes[0]).toMatchObject({ ok: false, code: '42501' });
      expect(outcomes[1]).toEqual({ ok: true, rows: [] });
      expect(outcomes[2]).toEqual({ ok: true, rows: [] });
    },
  );

  it('keeps the line as it was written after those attempts', async () => {
    const [line] = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 2 });
      await db.as(asAdmin());
      await db.attempt(
        `update cartlify.stock_log set "quantityChange" = 99 where "variantId" = $1`,
        product.variantId,
      );
      await db.attempt('delete from cartlify.stock_log where "variantId" = $1', product.variantId);
      return stockLogOf(db, admin.id, product.variantId);
    });

    expect(line).toMatchObject({ quantityChange: 2, stockAfter: 2 });
  });

  it('is not written by calling the function of the lines, which only the database steps may', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return db.attempt(
        `select cartlify.log_stock_change($1::int, 'stock.delivery', 1, 1, null, null, null, null)`,
        product.variantId,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it.each([
    ['an admin', asAdmin],
    ['root', asRoot],
  ])('is read by %s', async (_who, actorOf) => {
    const count = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 2 });
      await db.as(actorOf());
      const [row] = await db.rows<{ n: number }>(
        'select count(*)::int as n from cartlify.stock_log where "variantId" = $1',
        product.variantId,
      );
      return row!.n;
    });

    expect(count).toBe(1);
  });

  it.each([
    ['a buyer', () => ({ role: 'USER', userId: owner.id }) as Actor],
    ['a guest', () => ({ role: 'GUEST', guestId: randomUUID() }) as Actor],
    ['nobody', () => null],
  ])('is not read by %s', async (_who, actorOf) => {
    const count = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 2 });
      await db.as(actorOf());
      const [row] = await db.rows<{ n: number }>(
        'select count(*)::int as n from cartlify.stock_log',
      );
      return row!.n;
    });

    expect(count).toBe(0);
  });

  it('has a guard on the table that refuses an update and a delete besides the policies', async () => {
    const guards = await inRolledBackTx((db) =>
      db.rows<{ name: string; events: string }>(
        `select t.tgname as name,
                concat_ws(',',
                  case when t.tgtype & 16 <> 0 then 'update' end,
                  case when t.tgtype & 8 <> 0 then 'delete' end) as events
         from pg_trigger t
         where t.tgrelid = 'cartlify.stock_log'::regclass and not t.tgisinternal and t.tgenabled = 'O'`,
      ),
    );

    expect(guards).toEqual([{ name: 'trg_stock_log_append_only', events: 'update,delete' }]);
  });

  // the functions that move the stock run as the owner of the table, and an owner skips the policies
  // unless they are forced: they are (db/03), so the owner finds no line to change or remove. Tried
  // as the owner itself, not only read from the catalog; the guard of db/05 is the wall behind it
  it('lets its owner neither change nor remove a line', async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.username = 'cartlify_owner';
    url.password = 'cartlify_owner';
    url.search = '';
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();

    const outcomeOf = async (sql: string, id: number): Promise<string> => {
      await client.query('savepoint attempt');
      try {
        return `rows ${(await client.query(sql, [id])).rowCount}`;
      } catch (err) {
        const { code, message } = err as { code?: string; message: string };
        return `${code} ${message}`;
      } finally {
        await client.query('rollback to savepoint attempt');
      }
    };

    try {
      await client.query('begin');
      // the line is written the way the functions write one: for the system
      await client.query(
        'select cartlify.set_current_context($1::cartlify."Role", $2::int, $3::uuid)',
        ['ADMIN', null, null],
      );
      const { rows } = await client.query<{ id: number }>(
        `insert into cartlify.stock_log ("productId", "variantId", event, "quantityChange", "stockAfter")
         values ($1, $2, 'stock.delivery', 1, 3) returning id`,
        [product.id, product.variantId],
      );
      const id = rows[0]!.id;

      // the owner reaches a line only to empty its address and browser (the cleanup of the
      // retention terms): any other change is refused by the guard, a delete by the policy
      expect(
        await outcomeOf(`update cartlify.stock_log set "stockAfter" = 4 where id = $1`, id),
      ).toBe('42501 STOCK_LOG_APPEND_ONLY');
      expect(await outcomeOf(`delete from cartlify.stock_log where id = $1`, id)).toBe('rows 0');

      const kept = await client.query<{ stockAfter: number }>(
        `select "stockAfter" from cartlify.stock_log where id = $1`,
        [id],
      );
      expect(kept.rows).toEqual([{ stockAfter: 3 }]);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
  });
});

describe('the shape of a line', () => {
  it('keeps the variant with its product and refuses to lose a variant that has a line', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), sibling.id, { quantity: 2 });
      await db.as(asAdmin());
      return db.attempt(
        'delete from cartlify.product_variants where id = $1 returning id',
        sibling.id,
      );
    });

    // the key of the line names the variant and its product, restricting the delete
    expect(outcome).toMatchObject({ ok: false, code: '23503' });
  });

  it('refuses to delete a product that has a line', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), other.variantId, { quantity: 2 });
      await db.as(asAdmin());
      return db.attempt('delete from cartlify.products where id = $1 returning id', other.id);
    });

    expect(outcome).toMatchObject({ ok: false, code: '23503' });
  });

  it('restricts every key of the table, none of them cascades or clears', async () => {
    const keys = await inRolledBackTx((db) =>
      db.rows<{ name: string; onDelete: string }>(
        `select conname as name, confdeltype::text as "onDelete"
         from pg_constraint
         where conrelid = 'cartlify.stock_log'::regclass and contype = 'f'
         order by conname`,
      ),
    );

    expect(keys.map((key) => key.name)).toEqual([
      'stock_log_actorId_fkey',
      'stock_log_orderId_fkey',
      'stock_log_productId_fkey',
      'stock_log_returnItemId_fkey',
      'stock_log_variantId_productId_fkey',
    ]);
    // r: restrict
    expect(keys.every((key) => key.onDelete === 'r')).toBe(true);
  });

  it('has the checks of the event, the actor, the change, the operation and the changes', async () => {
    const checks = await inRolledBackTx((db) =>
      db.rows<{ name: string; definition: string; validated: boolean }>(
        `select conname as name, pg_get_constraintdef(oid) as definition, convalidated as validated
         from pg_constraint
         where conrelid = 'cartlify.stock_log'::regclass and contype = 'c'
         order by conname`,
      ),
    );

    expect(checks.map((check) => check.name)).toEqual([
      'stock_log_actor_chk',
      'stock_log_change_chk',
      'stock_log_event_chk',
      'stock_log_meta_chk',
      'stock_log_operation_chk',
      'stock_log_return_item_chk',
    ]);
    expect(checks.every((check) => check.validated)).toBe(true);
    // the event is written domain.name in lower case, as in the other journals
    expect(checks.find((check) => check.name === 'stock_log_event_chk')!.definition).toContain(
      '^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*$',
    );
  });

  it.each(STOCK_LOG_EVENTS)('takes the event %s in the shape the database keeps', (event) => {
    expect(event).toMatch(/^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*$/);
  });

  it('has only events of the list the app reads the journal by', async () => {
    const events = await inRolledBackTx(async (db) => {
      await batchIdOf(db, asAdmin(), product.variantId, { quantity: 5 });
      const orderId = await paidOrder(db, [[product.variantId, 2]]);
      await writeOff(db, asAdmin(), product.variantId, { quantity: 1, reason: 'damaged' });
      await cancel(db, asAdmin(), orderId);
      return (await stockLogOf(db, admin.id, product.variantId)).map((line) => line.event);
    });

    // the line of the goods that came back and went out at once comes with a statement whose goods
    // are written off or lost, not with a cancel (db/returns.test.ts)
    expect([...new Set(events)].sort()).toEqual(
      STOCK_LOG_EVENTS.filter((event) => event !== 'stock.return_write_off').sort(),
    );
  });
});

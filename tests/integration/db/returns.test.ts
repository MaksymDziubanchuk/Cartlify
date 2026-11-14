import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inCommittedTx, inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { cartOf, paidOrderOf, stockOf, waitingOrderOf } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  receiveBatch,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';

// the statement of a withdrawal or a return and its goods, in the database: who makes one, what it
// must hold (the order, the items and the quantities, the rule of the product, the period), how an
// admin takes the goods in (to the stock, written off, not accepted, lost, not arrived) and what each
// does to the stock, the batches, the stock log and the state of the order. The money is not here.
// All in transactions that roll back; what only the owner of the database writes (the holds of an
// order) is written as the owner, on an order the test commits

let buyer: TestUser;
let other: TestUser;
let admin: TestUser;
let root: TestUser;
let plain: TestProduct;
let perishable: TestProduct;
// stock in two batches, the first sold before the second: 3 units at cost 4 and 2 units at cost 6
let split: TestProduct;
// the product of the order a test commits: its units never come back to the stock of plain
let holdable: TestProduct;

beforeAll(async () => {
  buyer = await createUser({ name: 'Anna Koval' });
  other = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  plain = await createProduct({ price: 10, stock: 20 });
  holdable = await createProduct({ price: 10, stock: 10 });
  perishable = await createProduct({ price: 7, stock: 20, withdrawal: 'perishable' });
  split = await createProduct({ price: 12, stock: 0 });
  await receiveBatch({ variantId: split.variantId }, { quantity: 3, unitCost: 4 });
  await receiveBatch({ variantId: split.variantId }, { quantity: 2, unitCost: 6 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, other.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

type ItemRow = { id: number; variantId: number; quantity: number; unitPrice: number };

// a paid order with the units asked, and its items
async function soldOrder(db: DbSession, lines: Array<[TestProduct, number]>) {
  const orderId = await paidOrderOf(
    db,
    buyer.id,
    admin.id,
    lines.map(([product, quantity]) => [product.variantId, quantity]),
  );
  await db.as({ role: 'ADMIN', userId: admin.id });
  const items = await db.rows<ItemRow>(
    `select id, "variantId", quantity, "unitPrice"::float8 as "unitPrice"
     from cartlify.order_items where "orderId" = $1 order by id`,
    orderId,
  );
  return { orderId, items };
}

const asAdmin = (db: DbSession) => db.as({ role: 'ADMIN', userId: admin.id });

type Made = { returnId: number };

type Opts = {
  items: Array<{ orderItemId: number; quantity: number }>;
  source?: 'account' | 'form_code' | 'form_manual' | 'admin' | 'system';
  basis?: 'withdrawal' | 'other';
  reason?: string | null;
  description?: string | null;
  name?: string | null;
  email?: string | null;
  statedAt?: string | null;
  extendsId?: number | null;
  grace?: number;
  zone?: string;
};

// create_return as the actor now set in the session
const createReturn = (db: DbSession, orderId: number, opts: Opts) =>
  db.attempt<{ id: number }>(
    `select cartlify.create_return(
       $1::int, $2::jsonb, $3::cartlify."ReturnSource", $4::cartlify."ReturnBasis",
       $5::cartlify."ReturnReason", $6::text, $7::text, $8::text, $9::timestamp, $10::int,
       $11::int, $12::text
     ) as id`,
    orderId,
    JSON.stringify(opts.items),
    opts.source ?? 'admin',
    opts.basis ?? 'other',
    opts.reason === undefined ? 'defect' : opts.reason,
    opts.description ?? null,
    opts.name === undefined ? 'Anna Koval' : opts.name,
    opts.email === undefined ? 'anna@example.com' : opts.email,
    opts.statedAt ?? null,
    opts.extendsId ?? null,
    opts.grace ?? 4,
    opts.zone ?? 'Europe/Madrid',
  );

// a statement of an admin that must work
async function made(db: DbSession, orderId: number, opts: Opts): Promise<Made> {
  await asAdmin(db);
  const outcome = await createReturn(db, orderId, opts);
  if (!outcome.ok) throw new Error(`create_return refused: ${outcome.message}`);
  return { returnId: outcome.rows[0]!.id };
}

type Result = {
  itemId: number;
  quantity: number;
  goods: 'to_stock' | 'written_off' | 'not_accepted' | 'lost' | 'not_arrived';
  notAcceptedReason?: string;
};

const receive = (db: DbSession, returnId: number, results: Result[]) =>
  db.attempt(
    `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
    returnId,
    JSON.stringify(results),
  );

const confirmProof = (db: DbSession, returnId: number) =>
  db.attempt(`select 1 as done from cartlify.confirm_return_proof($1::int, 0::numeric)`, returnId);

type RowOfReturn = {
  id: number;
  orderItemId: number;
  quantity: number;
  goods: string;
  money: string;
  amount: number;
  notAcceptedReason: string | null;
};

const rowsOf = (db: DbSession, returnId: number) =>
  db.rows<RowOfReturn>(
    `select id, "orderItemId", quantity, goods::text as goods, money::text as money,
            amount::float8 as amount, "notAcceptedReason"::text as "notAcceptedReason"
     from cartlify.return_items where "returnId" = $1 order by id`,
    returnId,
  );

const headOf = async (db: DbSession, returnId: number) => {
  const [row] = await db.rows<{
    orderId: number;
    source: string;
    basis: string;
    reason: string | null;
    description: string | null;
    contactName: string;
    contactEmail: string;
    createdById: number | null;
    extendsId: number | null;
    closedAt: string | null;
    closedById: number | null;
    // the confirmation of the parcel the goods go back to the shop in
    proofConfirmedAt: string | null;
    proofConfirmedById: number | null;
    ip: string | null;
    userAgent: string | null;
    createdAtOk: boolean;
    statedAtOk: boolean;
  }>(
    `select "orderId", source::text as source, basis::text as basis, reason::text as reason,
            description, "contactName", "contactEmail", "createdById", "extendsId",
            "closedAt"::text as "closedAt", "closedById",
            (select p."confirmedAt"::text from cartlify.order_shipments as p
             where p."returnId" = r.id and p.direction = 'to_shop') as "proofConfirmedAt",
            (select p."confirmedById" from cartlify.order_shipments as p
             where p."returnId" = r.id and p.direction = 'to_shop') as "proofConfirmedById",
            ip, "userAgent",
            "createdAt" <= (now() at time zone 'UTC') + interval '1 second' as "createdAtOk",
            "statedAt" <= "createdAt" as "statedAtOk"
     from cartlify.returns as r where r.id = $1`,
    returnId,
  );
  return row!;
};

const statusOf = async (db: DbSession, orderId: number) => {
  const [row] = await db.rows<{ returnStatus: string }>(
    `select "returnStatus"::text as "returnStatus" from cartlify.orders where id = $1`,
    orderId,
  );
  return row!.returnStatus;
};

const batchesOf = (db: DbSession, variantId: number) =>
  db.rows<{ unitCost: number; remaining: number }>(
    `select "unitCost"::float8 as "unitCost", remaining from cartlify.product_batches
     where "variantId" = $1 order by id`,
    variantId,
  );

const allocationsOf = (db: DbSession, orderId: number) =>
  db.rows<{ quantity: number; returned: number }>(
    `select quantity, returned from cartlify.order_batch_allocations where "orderId" = $1 order by id`,
    orderId,
  );

const linesOf = (db: DbSession, orderId: number) =>
  db.rows<{
    event: string;
    quantityChange: number;
    returnItemId: number | null;
    stockAfter: number;
  }>(
    `select event, "quantityChange", "returnItemId", "stockAfter" from cartlify.stock_log
     where "orderId" = $1 and event in ('stock.return', 'stock.return_write_off') order by id`,
    orderId,
  );

describe('create_return', () => {
  // the number of a statement in its order makes its public code (W42-2): 1, 2, 3 per order, under
  // the lock of the order, and each order counts on its own
  it('numbers the statements of an order one after the other, each order on its own', async () => {
    const numbers = await inRolledBackTx(async (db) => {
      const first = await soldOrder(db, [[plain, 3]]);
      const second = await soldOrder(db, [[plain, 1]]);
      const one = { items: [{ orderItemId: first.items[0]!.id, quantity: 1 }] };
      const ids = [
        (await made(db, first.orderId, one)).returnId,
        (await made(db, first.orderId, one)).returnId,
        (
          await made(db, second.orderId, {
            items: [{ orderItemId: second.items[0]!.id, quantity: 1 }],
          })
        ).returnId,
      ];
      await asAdmin(db);
      return db.rows<{ id: number; number: number }>(
        `select id, number from cartlify.returns where id = any($1::int[]) order by id`,
        ids,
      );
    });

    expect(numbers.map((row) => row.number)).toEqual([1, 2, 1]);
  });

  it('makes the statement of an admin for the items of a paid order, with what the law needs of it', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [
        [plain, 3],
        [split, 2],
      ]);
      await asAdmin(db);
      await db.rows(
        `select set_config('cartlify.request_ip', '203.0.113.7', true),
                set_config('cartlify.request_user_agent', 'Admin Browser', true)`,
      );
      const { returnId } = await made(db, orderId, {
        items: [
          { orderItemId: items[0]!.id, quantity: 2 },
          { orderItemId: items[1]!.id, quantity: 1 },
        ],
        description: 'The box came open.',
      });
      return {
        items,
        head: await headOf(db, returnId),
        rows: await rowsOf(db, returnId),
        orderId,
        db: await statusOf(db, orderId),
      };
    });

    expect(result.head).toMatchObject({
      orderId: result.orderId,
      source: 'admin',
      basis: 'other',
      reason: 'defect',
      description: 'The box came open.',
      contactName: 'Anna Koval',
      contactEmail: 'anna@example.com',
      createdById: admin.id,
      extendsId: null,
      closedAt: null,
      proofConfirmedAt: null,
      ip: '203.0.113.7',
      userAgent: 'Admin Browser',
      createdAtOk: true,
      statedAtOk: true,
    });
    // a row for each item, waiting for the goods and for the money, the sum of the units at the
    // price they were bought at
    expect(result.rows).toEqual([
      expect.objectContaining({
        orderItemId: result.items[0]!.id,
        quantity: 2,
        goods: 'expected',
        money: 'not_refunded',
        amount: 20,
        notAcceptedReason: null,
      }),
      expect.objectContaining({
        orderItemId: result.items[1]!.id,
        quantity: 1,
        goods: 'expected',
        money: 'not_refunded',
        amount: 12,
      }),
    ]);
    expect(result.db).toBe('open');
  });

  it('is dated by the database, and by the admin when they give a moment of the past', async () => {
    const dates = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      await asAdmin(db);
      const [paid] = await db.rows<{ at: string }>(
        `select "paidAt"::text as at from cartlify.orders where id = $1`,
        orderId,
      );
      const now = await made(db, orderId, { items: [{ orderItemId: items[0]!.id, quantity: 1 }] });
      const past = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
        statedAt: paid!.at,
        basis: 'withdrawal',
        reason: 'goodwill',
        grace: 4,
      });
      const [a, b] = await db.rows<{ statedAt: string; seconds: number }>(
        `select "statedAt"::text as "statedAt",
                extract(epoch from (now() at time zone 'UTC') - "statedAt")::float8 as seconds
         from cartlify.returns where id in ($1, $2) order by id`,
        now.returnId,
        past.returnId,
      );
      return { a: a!, b: b!, paid: paid!.at };
    });

    expect(Math.abs(dates.a.seconds)).toBeLessThan(60);
    expect(dates.b.statedAt).toBe(dates.paid);
  });

  it('refuses a moment before the order was paid: a withdrawal cannot come before the purchase', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await asAdmin(db);
      return createReturn(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
        statedAt: '2026-01-02 10:00:00',
      });
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_STATED_AT_INVALID'),
    });
  });

  it('refuses a moment of the future', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await asAdmin(db);
      return createReturn(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
        statedAt: '2999-01-01 00:00:00',
      });
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_STATED_AT_INVALID'),
    });
  });

  it.each([
    ['a cart', (db: DbSession) => cartOf(db, buyer.id, [[plain.variantId, 1]])],
    [
      'an order that waits for its payment',
      (db: DbSession) => waitingOrderOf(db, buyer.id, [[plain.variantId, 1]]),
    ],
  ])('refuses %s (RETURN_ORDER_NOT_RETURNABLE)', async (_case, orderOf) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await orderOf(db);
      await asAdmin(db);
      const [item] = await db.rows<{ id: number }>(
        'select id from cartlify.order_items where "orderId" = $1',
        orderId,
      );
      return createReturn(db, orderId, { items: [{ orderItemId: item!.id, quantity: 1 }] });
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ORDER_NOT_RETURNABLE'),
    });
  });

  it('works on a shipped and on a delivered order', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      await asAdmin(db);
      await db.rows(
        `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
        orderId,
      );
      const shipped = await createReturn(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      await db.rows(
        `update cartlify.orders set status = 'delivered' where id = $1 returning id`,
        orderId,
      );
      const delivered = await createReturn(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      return [shipped.ok, delivered.ok];
    });

    expect(outcomes).toEqual([true, true]);
  });

  it.each([
    ['an item of another order', 'RETURN_ITEM_NOT_FOUND'],
    ['more units than were bought', 'RETURN_QUANTITY_EXCEEDED'],
    ['no units', 'RETURN_QUANTITY_INVALID'],
    ['a negative number of units', 'RETURN_QUANTITY_INVALID'],
    ['an empty list', 'RETURN_ITEMS_REQUIRED'],
    ['an item named twice', 'RETURN_ITEMS_REPEATED'],
  ])('refuses %s (%s)', async (what, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      const elsewhere = await soldOrder(db, [[plain, 1]]);
      await asAdmin(db);
      const own = items[0]!.id;
      const list = {
        'an item of another order': [{ orderItemId: elsewhere.items[0]!.id, quantity: 1 }],
        'more units than were bought': [{ orderItemId: own, quantity: 3 }],
        'no units': [{ orderItemId: own, quantity: 0 }],
        'a negative number of units': [{ orderItemId: own, quantity: -1 }],
        'an empty list': [],
        'an item named twice': [
          { orderItemId: own, quantity: 1 },
          { orderItemId: own, quantity: 1 },
        ],
      }[what]!;
      return createReturn(db, orderId, { items: list });
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it('counts the units that other statements hold: a second statement gets only what is left', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 5]]);
      const item = items[0]!.id;
      await made(db, orderId, { items: [{ orderItemId: item, quantity: 3 }] });
      await asAdmin(db);
      const tooMany = await createReturn(db, orderId, {
        items: [{ orderItemId: item, quantity: 3 }],
      });
      const rest = await createReturn(db, orderId, { items: [{ orderItemId: item, quantity: 2 }] });
      return { tooMany, rest };
    });

    expect(outcomes.tooMany).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_QUANTITY_EXCEEDED'),
    });
    expect(outcomes.rest.ok).toBe(true);
  });

  it('frees the units of a row the admin did not accept: the item may be claimed again', async () => {
    const again = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      const item = items[0]!.id;
      const { returnId } = await made(db, orderId, { items: [{ orderItemId: item, quantity: 2 }] });
      await asAdmin(db);
      await receive(db, returnId, [
        {
          itemId: (await rowsOf(db, returnId))[0]!.id,
          quantity: 2,
          goods: 'not_accepted',
          notAcceptedReason: 'unsealed',
        },
      ]);
      return createReturn(db, orderId, { items: [{ orderItemId: item, quantity: 2 }] });
    });

    expect(again.ok).toBe(true);
  });

  describe('the rule of withdrawal and the period', () => {
    it('refuses a statement of withdrawal for an item that is not taken back (RETURN_ITEM_NOT_RETURNABLE)', async () => {
      const outcome = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[perishable, 1]]);
        await asAdmin(db);
        return createReturn(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 1 }],
          basis: 'withdrawal',
          reason: 'goodwill',
        });
      });

      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_ITEM_NOT_RETURNABLE'),
      });
    });

    it('takes the same item for a statement outside the withdrawal: a defect has no such rule', async () => {
      const outcome = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[perishable, 1]]);
        await asAdmin(db);
        return createReturn(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 1 }],
          basis: 'other',
          reason: 'defect',
        });
      });

      expect(outcome.ok).toBe(true);
    });

    it('refuses a withdrawal after the period of a delivered order (RETURN_PERIOD_OVER), not before it', async () => {
      const outcomes = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[plain, 2]]);
        await asAdmin(db);
        await db.rows(
          `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
          orderId,
        );
        await db.rows(
          `update cartlify.orders set status = 'delivered' where id = $1 returning id`,
          orderId,
        );
        const item = items[0]!.id;
        const within = await createReturn(db, orderId, {
          items: [{ orderItemId: item, quantity: 1 }],
          basis: 'withdrawal',
          reason: 'goodwill',
          grace: 0,
        });
        // the grace that is past: days and grace together end before the delivery
        const over = await createReturn(db, orderId, {
          items: [{ orderItemId: item, quantity: 1 }],
          basis: 'withdrawal',
          reason: 'goodwill',
          grace: -100,
        });
        return { within, over };
      });

      expect(outcomes.within.ok).toBe(true);
      expect(outcomes.over).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_PERIOD_OVER'),
      });
    });

    it('does not start the period before the delivery: a paid order may be withdrawn from', async () => {
      const outcome = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[plain, 1]]);
        await asAdmin(db);
        return createReturn(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 1 }],
          basis: 'withdrawal',
          reason: 'goodwill',
          grace: -100,
        });
      });

      expect(outcome.ok).toBe(true);
    });
  });

  describe('an extension', () => {
    it('is a statement of its own that points at the one it extends', async () => {
      const head = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[plain, 4]]);
        const first = await made(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 1 }],
        });
        const second = await made(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 2 }],
          extendsId: first.returnId,
        });
        return { first, head: await headOf(db, second.returnId) };
      });

      expect(head.head.extendsId).toBe(head.first.returnId);
    });

    it('may only extend a statement of the same order (RETURN_EXTENDS_INVALID)', async () => {
      const outcome = await inRolledBackTx(async (db) => {
        const one = await soldOrder(db, [[plain, 1]]);
        const two = await soldOrder(db, [[plain, 1]]);
        const first = await made(db, one.orderId, {
          items: [{ orderItemId: one.items[0]!.id, quantity: 1 }],
        });
        await asAdmin(db);
        return createReturn(db, two.orderId, {
          items: [{ orderItemId: two.items[0]!.id, quantity: 1 }],
          extendsId: first.returnId,
        });
      });

      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_EXTENDS_INVALID'),
      });
    });
  });

  describe('who makes a statement', () => {
    it('lets the buyer of the order make one of withdrawal from the account, with their own data', async () => {
      const result = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[plain, 2]]);
        await db.as({ role: 'USER', userId: buyer.id });
        const outcome = await createReturn(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 1 }],
          source: 'account',
          basis: 'withdrawal',
          reason: null,
          description: 'I changed my mind.',
        });
        if (!outcome.ok) return outcome;
        return { ok: true as const, head: await headOf(db, outcome.rows[0]!.id) };
      });

      expect(result.ok).toBe(true);
      expect((result as { head: unknown }).head).toMatchObject({
        source: 'account',
        basis: 'withdrawal',
        reason: null,
        createdById: buyer.id,
        description: 'I changed my mind.',
      });
    });

    it.each([
      ['a buyer for the order of another', 'USER', 'account', 'withdrawal', true],
      ['a buyer with the source of an admin', 'USER', 'admin', 'other', false],
      ['a buyer with a statement outside the withdrawal', 'USER', 'account', 'other', false],
      ['an admin with the source of an account', 'ADMIN', 'account', 'withdrawal', false],
      ['a guest', 'GUEST', 'account', 'withdrawal', false],
    ] as const)(
      'refuses %s (RETURN_FORBIDDEN or RETURN_ORDER_NOT_FOUND)',
      async (_case, role, source, basis, foreign) => {
        const outcome = await inRolledBackTx(async (db) => {
          const { orderId, items } = await soldOrder(db, [[plain, 1]]);
          await db.as(
            role === 'GUEST'
              ? { role: 'GUEST', guestId: '11111111-1111-4111-8111-111111111111' }
              : role === 'ADMIN'
                ? { role, userId: admin.id }
                : { role, userId: foreign ? other.id : buyer.id },
          );
          return createReturn(db, orderId, {
            items: [{ orderItemId: items[0]!.id, quantity: 1 }],
            source,
            basis,
            reason: source === 'admin' ? 'defect' : null,
          });
        });

        expect(outcome).toMatchObject({
          ok: false,
          message: expect.stringMatching(/RETURN_FORBIDDEN|RETURN_ORDER_NOT_FOUND/),
        });
      },
    );

    it('lets the system make one from the form, which the code in the link vouched for', async () => {
      const outcome = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[plain, 1]]);
        await db.as({ role: 'ADMIN', userId: null });
        return createReturn(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 1 }],
          source: 'form_code',
          basis: 'withdrawal',
          reason: null,
        });
      });

      expect(outcome.ok).toBe(true);
    });

    it('wants the name and the email of the statement', async () => {
      const outcome = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[plain, 1]]);
        await asAdmin(db);
        return createReturn(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 1 }],
          name: '   ',
          email: null,
        });
      });

      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_CONTACT_REQUIRED'),
      });
    });
  });
});

describe('the goods of a statement: receive_return_items', () => {
  it('puts units back into the stock and into the batches they were sold from, in the order of the sale', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[split, 5]]);
      const stockBefore = await stockOf(db, admin.id, split.variantId);
      const batchesBefore = await batchesOf(db, split.variantId);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 4 }],
      });
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      const outcome = await receive(db, returnId, [
        { itemId: row!.id, quantity: 4, goods: 'to_stock' },
      ]);
      return {
        outcome,
        stockBefore,
        stockAfter: await stockOf(db, admin.id, split.variantId),
        batchesBefore,
        batches: await batchesOf(db, split.variantId),
        allocations: await allocationsOf(db, orderId),
        lines: await linesOf(db, orderId),
        rows: await rowsOf(db, returnId),
      };
    });

    expect(result.outcome.ok).toBe(true);
    expect(result.stockAfter!.stock).toBe(result.stockBefore!.stock + 4);
    // sold 3 from the first batch and 2 from the second: 4 units go back 3 and 1
    expect(result.allocations).toEqual([
      { quantity: 3, returned: 3 },
      { quantity: 2, returned: 1 },
    ]);
    expect(result.batches.map((batch) => batch.remaining)).toEqual(
      result.batchesBefore.map((batch, index) => batch.remaining + [3, 1][index]!),
    );
    expect(result.lines).toEqual([
      expect.objectContaining({
        event: 'stock.return',
        quantityChange: 4,
        returnItemId: result.rows[0]!.id,
        stockAfter: result.stockAfter!.stock,
      }),
    ]);
    expect(result.rows).toEqual([
      expect.objectContaining({ goods: 'to_stock', quantity: 4, money: 'not_refunded' }),
    ]);
  });

  it('splits a row when only some of its units are taken in, and keeps the rest waiting', async () => {
    const rows = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 3]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 3 }],
      });
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 2, goods: 'to_stock' }]);
      return rowsOf(db, returnId);
    });

    // the units with a result are a row of their own, the rest stays; the money goes by the units
    expect(rows.map((row) => [row.goods, row.quantity, row.amount])).toEqual([
      ['expected', 1, 10],
      ['to_stock', 2, 20],
    ]);
  });

  it('puts a unit that comes later in with its own result: one by one over several days', async () => {
    const rows = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 3]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 3 }],
      });
      await asAdmin(db);
      let row: RowOfReturn | undefined = (await rowsOf(db, returnId))[0];
      await receive(db, returnId, [{ itemId: row!.id, quantity: 2, goods: 'to_stock' }]);
      row = (await rowsOf(db, returnId)).find((one) => one.goods === 'expected');
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
      return rowsOf(db, returnId);
    });

    expect(rows.map((row) => [row.goods, row.quantity]).sort()).toEqual([
      ['to_stock', 1],
      ['to_stock', 2],
    ]);
  });

  it.each([
    ['written off', 'written_off' as const],
    ['lost', 'lost' as const],
  ])(
    'takes units %s in and out at once: the same batches, a line of each, the stock as it was',
    async (_name, goods) => {
      const result = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[split, 5]]);
        const { returnId } = await made(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 4 }],
        });
        await asAdmin(db);
        if (goods === 'lost') await confirmProof(db, returnId);
        const stockBefore = await stockOf(db, admin.id, split.variantId);
        const batchesBefore = await batchesOf(db, split.variantId);
        const [row] = await rowsOf(db, returnId);
        const outcome = await receive(db, returnId, [{ itemId: row!.id, quantity: 4, goods }]);
        return {
          outcome,
          stockBefore,
          stockAfter: await stockOf(db, admin.id, split.variantId),
          batchesBefore,
          batches: await batchesOf(db, split.variantId),
          allocations: await allocationsOf(db, orderId),
          lines: await linesOf(db, orderId),
        };
      });

      expect(result.outcome.ok).toBe(true);
      expect(result.stockAfter).toEqual(result.stockBefore);
      expect(result.batches).toEqual(result.batchesBefore);
      // the units came back to the batches they were sold from, which the cost of the loss needs
      expect(result.allocations).toEqual([
        { quantity: 3, returned: 3 },
        { quantity: 2, returned: 1 },
      ]);
      expect(result.lines.map((line) => [line.event, line.quantityChange])).toEqual([
        ['stock.return', 4],
        ['stock.return_write_off', -4],
      ]);
      expect(new Set(result.lines.map((line) => line.returnItemId)).size).toBe(1);
      expect(result.lines.map((line) => line.stockAfter)).toEqual([
        result.stockBefore!.stock + 4,
        result.stockBefore!.stock,
      ]);
    },
  );

  it('does not take units in as lost before the parcel is confirmed (RETURN_PARCEL_REQUIRED)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      return db.attempt(
        `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb)`,
        returnId,
        JSON.stringify([{ itemId: row!.id, quantity: 1, goods: 'lost' }]),
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_PARCEL_REQUIRED'),
    });
  });

  it.each([
    [
      'not accepted',
      { goods: 'not_accepted' as const, notAcceptedReason: 'unsealed' },
      'not_accepted',
    ],
    ['not arrived', { goods: 'not_arrived' as const }, 'not_arrived'],
  ])(
    'takes units %s: no stock moves, the money of the row is refused, and the statement is over',
    async (_name, result, goods) => {
      const state = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[plain, 2]]);
        const { returnId } = await made(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 2 }],
        });
        await asAdmin(db);
        const stockBefore = await stockOf(db, admin.id, plain.variantId);
        const [row] = await rowsOf(db, returnId);
        const outcome = await receive(db, returnId, [{ itemId: row!.id, quantity: 2, ...result }]);
        return {
          outcome,
          stockBefore,
          stockAfter: await stockOf(db, admin.id, plain.variantId),
          rows: await rowsOf(db, returnId),
          head: await headOf(db, returnId),
          lines: await linesOf(db, orderId),
          status: await statusOf(db, orderId),
        };
      });

      expect(state.outcome.ok).toBe(true);
      expect(state.stockAfter).toEqual(state.stockBefore);
      expect(state.lines).toEqual([]);
      expect(state.rows).toEqual([
        expect.objectContaining({
          goods,
          money: 'refused',
          quantity: 2,
          notAcceptedReason: goods === 'not_accepted' ? 'unsealed' : null,
        }),
      ]);
      // nothing is left to settle: the statement is closed by the admin who set the last result
      expect(state.head.closedAt).not.toBeNull();
      expect(state.head.closedById).toBe(admin.id);
      expect(state.status).toBe('declined');
    },
  );

  it('wants the reason of a refusal to accept (RETURN_NOT_ACCEPTED_REASON_REQUIRED), and only for it', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 2 }],
      });
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      const without = await receive(db, returnId, [
        { itemId: row!.id, quantity: 1, goods: 'not_accepted' },
      ]);
      const extra = await receive(db, returnId, [
        { itemId: row!.id, quantity: 1, goods: 'to_stock', notAcceptedReason: 'unsealed' },
      ]);
      return { without, extra };
    });

    expect(outcomes.without).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_NOT_ACCEPTED_REASON_REQUIRED'),
    });
    expect(outcomes.extra).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_GOODS_INVALID'),
    });
  });

  it('leaves the statement open while a row waits for its goods or for the money of its goods', async () => {
    const state = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 2 }],
      });
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'not_arrived' }]);
      const half = await headOf(db, returnId);
      const waiting = (await rowsOf(db, returnId)).find((one) => one.goods === 'expected')!;
      await receive(db, returnId, [{ itemId: waiting.id, quantity: 1, goods: 'to_stock' }]);
      return { half, end: await headOf(db, returnId), status: await statusOf(db, orderId) };
    });

    // the unit taken in waits for its money (a later step): the statement is not closed
    expect(state.half.closedAt).toBeNull();
    expect(state.end.closedAt).toBeNull();
    expect(state.status).toBe('open');
  });

  it.each([
    [
      'more units than the row holds',
      (row: RowOfReturn): Result => ({
        itemId: row.id,
        quantity: row.quantity + 1,
        goods: 'to_stock',
      }),
      'RETURN_QUANTITY_EXCEEDED',
    ],
    [
      'no units',
      (row: RowOfReturn): Result => ({ itemId: row.id, quantity: 0, goods: 'to_stock' }),
      'RETURN_QUANTITY_INVALID',
    ],
    [
      'a row that is not there',
      (): Result => ({ itemId: 2_147_483_000, quantity: 1, goods: 'to_stock' }),
      'RETURN_ITEM_NOT_FOUND',
    ],
    [
      'a result there is not',
      (row: RowOfReturn): Result => ({ itemId: row.id, quantity: 1, goods: 'expected' as never }),
      'RETURN_GOODS_INVALID',
    ],
  ])('refuses %s (%s)', async (_what, result, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 2 }],
      });
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      return receive(db, returnId, [result(row!)]);
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it('refuses a row that has a result already (RETURN_ITEM_NOT_EXPECTED): units come in once', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      // two units, one stated: the order stays open (all of it back would cancel it)
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
      return receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEM_NOT_EXPECTED'),
    });
  });

  it('is all or none: a wrong result among right ones changes nothing', async () => {
    const state = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 2 }],
      });
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      const stockBefore = await stockOf(db, admin.id, plain.variantId);
      const outcome = await receive(db, returnId, [
        { itemId: row!.id, quantity: 1, goods: 'to_stock' },
        { itemId: row!.id, quantity: 5, goods: 'to_stock' },
      ]);
      return {
        outcome,
        stockBefore,
        stockAfter: await stockOf(db, admin.id, plain.variantId),
        rows: await rowsOf(db, returnId),
      };
    });

    expect(state.outcome.ok).toBe(false);
    expect(state.stockAfter).toEqual(state.stockBefore);
    expect(state.rows).toEqual([expect.objectContaining({ goods: 'expected', quantity: 2 })]);
  });

  it.each([
    ['a buyer', { role: 'USER' as const, userId: (): number | null => buyer.id }],
    ['a guest', { role: 'GUEST' as const, userId: (): number | null => null }],
  ])('is not for %s (RETURN_FORBIDDEN)', async (_who, who) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      await db.as({ role: who.role, userId: who.userId() });
      return receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
  });

  it('works for root as for an admin', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      const [row] = await rowsOf(db, returnId);
      await db.as({ role: 'ROOT', userId: root.id });
      return receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
    });

    expect(outcome.ok).toBe(true);
  });

  it('refuses a statement that is not there (RETURN_NOT_FOUND)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await asAdmin(db);
      return receive(db, 2_147_483_000, [{ itemId: 1, quantity: 1, goods: 'to_stock' }]);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_NOT_FOUND'),
    });
  });
});

describe('the reasons that cancel an order', () => {
  // an admin ships the order: the step after paid
  const ship = async (db: DbSession, orderId: number) => {
    await asAdmin(db);
    await db.rows(
      `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
      orderId,
    );
  };

  const paidAtOf = async (db: DbSession, orderId: number) => {
    const [row] = await db.rows<{ at: string }>(
      `select "paidAt"::text as at from cartlify.orders where id = $1`,
      orderId,
    );
    return row!.at;
  };

  const orderOf = async (db: DbSession, orderId: number) => {
    const [row] = await db.rows<{
      status: string;
      cancelledAt: string | null;
      returnStatus: string;
    }>(
      `select status::text as status, "cancelledAt"::text as "cancelledAt",
              "returnStatus"::text as "returnStatus"
       from cartlify.orders where id = $1`,
      orderId,
    );
    return row!;
  };

  it('shop_cancel takes every unit back to the stock at once, in the batches it came from, and cancels the order', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[split, 5]]);
      const stockBefore = await stockOf(db, admin.id, split.variantId);
      const batchesBefore = await batchesOf(db, split.variantId);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 5 }],
        reason: 'shop_cancel',
      });
      await asAdmin(db);
      return {
        stockBefore,
        stockAfter: await stockOf(db, admin.id, split.variantId),
        batchesBefore,
        batches: await batchesOf(db, split.variantId),
        allocations: await allocationsOf(db, orderId),
        lines: await linesOf(db, orderId),
        rows: await rowsOf(db, returnId),
        order: await orderOf(db, orderId),
      };
    });

    expect(result.stockAfter!.stock).toBe(result.stockBefore!.stock + 5);
    expect(result.batches.map((batch) => batch.remaining)).toEqual(
      result.batchesBefore.map((batch, index) => batch.remaining + [3, 2][index]!),
    );
    expect(result.allocations).toEqual([
      { quantity: 3, returned: 3 },
      { quantity: 2, returned: 2 },
    ]);
    expect(result.lines.map((line) => [line.event, line.quantityChange])).toEqual([
      ['stock.return', 5],
    ]);
    // the money is a step of its own: the rows wait for it
    expect(result.rows).toEqual([
      expect.objectContaining({ goods: 'to_stock', money: 'not_refunded', quantity: 5 }),
    ]);
    expect(result.order).toMatchObject({
      status: 'cancelled',
      cancelledAt: expect.any(String),
      returnStatus: 'open',
    });
  });

  it('shop_cancel of a part of the order puts those units back and leaves the order paid', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 3]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 2 }],
        reason: 'shop_cancel',
      });
      await asAdmin(db);
      return { rows: await rowsOf(db, returnId), order: await orderOf(db, orderId) };
    });

    expect(result.rows).toEqual([expect.objectContaining({ goods: 'to_stock', quantity: 2 })]);
    expect(result.order).toMatchObject({ status: 'paid', cancelledAt: null });
  });

  it('cancels a paid order when every unit of it came back with any statement, not only shop_cancel', async () => {
    const order = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 2 }],
      });
      await asAdmin(db);
      const before = await orderOf(db, orderId);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 2, goods: 'to_stock' }]);
      return { before, after: await orderOf(db, orderId) };
    });

    expect(order.before.status).toBe('paid');
    expect(order.after).toMatchObject({ status: 'cancelled', cancelledAt: expect.any(String) });
  });

  it.each([
    [
      'a basis other than other (RETURN_REASON_INVALID)',
      'withdrawal' as const,
      async () => undefined,
      'RETURN_REASON_INVALID',
    ],
    [
      'an order that was shipped (RETURN_ORDER_NOT_RETURNABLE)',
      'other' as const,
      async (db: DbSession, orderId: number) => ship(db, orderId),
      'RETURN_ORDER_NOT_RETURNABLE',
    ],
  ])('refuses shop_cancel for %s', async (_what, basis, prepare, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await prepare(db, orderId);
      await asAdmin(db);
      return createReturn(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
        basis,
        reason: 'shop_cancel',
      });
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it('refuses shop_cancel for an order that is cancelled already (RETURN_ORDER_NOT_RETURNABLE)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
        reason: 'shop_cancel',
      });
      await asAdmin(db);
      return createReturn(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
        reason: 'shop_cancel',
      });
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ORDER_NOT_RETURNABLE'),
    });
  });

  // the order the bank took the money of (a dispute the shop lost), or whose whole payment went back
  // by hand in the dashboard of the provider, is cancelled by a statement the system makes: the
  // same way as a cancel by the shop, so the stock, the money and the alerts go as for any statement
  describe('a statement of the system', () => {
    // the server acting by itself: the payment webhook
    const asSystem = (db: DbSession) => db.as({ role: 'ADMIN' });

    it.each([['dispute_lost'], ['stripe_refund']])(
      'with the reason %s takes what is left of a paid order back to the stock at once, as a cancel by the shop',
      async (reason) => {
        const result = await inRolledBackTx(async (db) => {
          const { orderId, items } = await soldOrder(db, [[plain, 3]]);
          // a unit is held by a statement of an admin already: the system takes the rest
          await made(db, orderId, { items: [{ orderItemId: items[0]!.id, quantity: 1 }] });
          const stockBefore = await stockOf(db, admin.id, plain.variantId);
          await asSystem(db);
          const outcome = await createReturn(db, orderId, {
            items: [{ orderItemId: items[0]!.id, quantity: 2 }],
            source: 'system',
            basis: 'other',
            reason,
          });
          if (!outcome.ok) throw new Error(`create_return refused: ${outcome.message}`);
          const returnId = outcome.rows[0]!.id;
          await asAdmin(db);
          return {
            head: await headOf(db, returnId),
            rows: await rowsOf(db, returnId),
            stockBefore,
            stockAfter: await stockOf(db, admin.id, plain.variantId),
            lines: (await linesOf(db, orderId)).filter((line) => line.returnItemId !== null),
            order: await orderOf(db, orderId),
          };
        });

        expect(result.head).toMatchObject({ source: 'system', basis: 'other', reason });
        // the money is a step of its own: the rows wait for it
        expect(result.rows).toEqual([
          expect.objectContaining({ goods: 'to_stock', money: 'not_refunded', quantity: 2 }),
        ]);
        expect(result.stockAfter!.stock).toBe(result.stockBefore!.stock + 2);
        expect(result.lines.filter((line) => line.returnItemId === result.rows[0]!.id)).toEqual([
          expect.objectContaining({ event: 'stock.return', quantityChange: 2 }),
        ]);
        // the unit of the statement of the admin is not back yet: the order is not cancelled until
        // every unit of it is
        expect(result.order).toMatchObject({ status: 'paid' });
      },
    );

    it('cancels the order when it takes the whole of it', async () => {
      const order = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[plain, 2]]);
        await asSystem(db);
        const outcome = await createReturn(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 2 }],
          source: 'system',
          basis: 'other',
          reason: 'dispute_lost',
        });
        if (!outcome.ok) throw new Error(`create_return refused: ${outcome.message}`);
        await asAdmin(db);
        return orderOf(db, orderId);
      });

      expect(order).toMatchObject({
        status: 'cancelled',
        cancelledAt: expect.any(String),
        returnStatus: 'open',
      });
    });

    it.each([
      ['an admin', () => ({ role: 'ADMIN' as const, userId: admin.id })],
      ['root', () => ({ role: 'ROOT' as const, userId: root.id })],
      ['the buyer', () => ({ role: 'USER' as const, userId: buyer.id })],
    ])('is made by the system only: %s is refused (RETURN_FORBIDDEN)', async (_who, actor) => {
      const outcome = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[plain, 1]]);
        await db.as(actor());
        return createReturn(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 1 }],
          source: 'system',
          basis: 'other',
          reason: 'dispute_lost',
        });
      });

      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_FORBIDDEN'),
      });
    });

    it.each([
      [
        'a basis other than other (RETURN_REASON_INVALID)',
        'withdrawal' as const,
        async () => undefined,
        'RETURN_REASON_INVALID',
      ],
      [
        'an order that was shipped (RETURN_ORDER_NOT_RETURNABLE)',
        'other' as const,
        async (db: DbSession, orderId: number) => ship(db, orderId),
        'RETURN_ORDER_NOT_RETURNABLE',
      ],
    ])('refuses it as a cancel by the shop is refused: %s', async (_what, basis, prepare, code) => {
      const outcome = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[plain, 1]]);
        await prepare(db, orderId);
        await asSystem(db);
        return createReturn(db, orderId, {
          items: [{ orderItemId: items[0]!.id, quantity: 1 }],
          source: 'system',
          basis,
          reason: 'stripe_refund',
        });
      });

      expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
    });
  });

  // what holds an order back from its sending (a dispute, a refund by hand, a warning or a review of
  // the provider) has nothing left to hold once the order is cancelled: the cancel empties it. The
  // list is written by the functions of the money (orderHolds.test.ts); here as the owner writes it,
  // on an order the test commits (the owner is another connection)
  describe('a cancel of an order that something holds', () => {
    let heldOrder: { orderId: number; itemId: number };

    beforeAll(async () => {
      heldOrder = await inCommittedTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[holdable, 2]]);
        return { orderId, itemId: items[0]!.id };
      });
    });

    it('empties the holds of the order it cancels', async () => {
      const result = await inOwnerTx(async (q) => {
        const holdsOf = async () => {
          await q.as({ role: 'ADMIN', userId: admin.id });
          const [row] = await q.rows<{ status: string; holds: unknown }>(
            `select status::text as status, holds from cartlify.orders where id = $1`,
            heldOrder.orderId,
          );
          return row!;
        };
        await q.as({ role: 'ADMIN' });
        const held = await q.attempt(
          `update cartlify.orders set holds = $2::jsonb where id = $1 returning id`,
          heldOrder.orderId,
          JSON.stringify([{ reason: 'fraud_warning', since: '2026-01-01T00:00:00Z', ref: 1 }]),
        );
        const before = await holdsOf();
        await q.as({ role: 'ADMIN', userId: admin.id });
        const cancelled = await q.attempt(
          `select cartlify.create_return(
             $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
             'shop_cancel'::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null,
             null, 4, 'Europe/Madrid'
           ) as id`,
          heldOrder.orderId,
          JSON.stringify([{ orderItemId: heldOrder.itemId, quantity: 2 }]),
        );
        return { held, before, cancelled, after: await holdsOf() };
      });

      expect(result.held.ok).toBe(true);
      expect(result.before).toEqual({
        status: 'paid',
        holds: [{ reason: 'fraud_warning', since: '2026-01-01T00:00:00Z', ref: 1 }],
      });
      expect(result.cancelled.ok).toBe(true);
      expect(result.after).toEqual({ status: 'cancelled', holds: [] });
    });

    it('keeps the holds of an order a statement takes only a part of', async () => {
      const result = await inOwnerTx(async (q) => {
        await q.as({ role: 'ADMIN' });
        const hold = [{ reason: 'dispute', since: '2026-01-01T00:00:00Z', ref: 7 }];
        await q.rows(
          `update cartlify.orders set holds = $2::jsonb where id = $1 returning id`,
          heldOrder.orderId,
          JSON.stringify(hold),
        );
        await q.as({ role: 'ADMIN', userId: admin.id });
        const part = await q.attempt(
          `select cartlify.create_return(
             $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
             'shop_cancel'::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null,
             null, 4, 'Europe/Madrid'
           ) as id`,
          heldOrder.orderId,
          JSON.stringify([{ orderItemId: heldOrder.itemId, quantity: 1 }]),
        );
        const [row] = await q.rows<{ status: string; holds: unknown }>(
          `select status::text as status, holds from cartlify.orders where id = $1`,
          heldOrder.orderId,
        );
        return { part, hold, order: row! };
      });

      expect(result.part.ok).toBe(true);
      expect(result.order).toEqual({ status: 'paid', holds: result.hold });
    });
  });

  it('refused takes whatever is left of a shipped order, whatever part was named, and moves no stock', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 3]]);
      // a unit is held by another statement already
      await made(db, orderId, { items: [{ orderItemId: items[0]!.id, quantity: 1 }] });
      await ship(db, orderId);
      const stockBefore = await stockOf(db, admin.id, plain.variantId);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
        basis: 'withdrawal',
        reason: 'refused',
        statedAt: await paidAtOf(db, orderId),
      });
      await asAdmin(db);
      return {
        rows: await rowsOf(db, returnId),
        order: await orderOf(db, orderId),
        stockBefore,
        stockAfter: await stockOf(db, admin.id, plain.variantId),
      };
    });

    // 1 unit named, the 2 that were left are taken
    expect(result.rows).toEqual([
      expect.objectContaining({ quantity: 2, goods: 'expected', amount: 20 }),
    ]);
    expect(result.order.status).toBe('shipped');
    expect(result.stockAfter).toEqual(result.stockBefore);
  });

  it.each([
    [
      'a basis other than withdrawal (RETURN_REASON_INVALID)',
      'other' as const,
      true,
      'RETURN_REASON_INVALID',
    ],
    [
      'an order that was not sent (RETURN_ORDER_NOT_RETURNABLE)',
      'withdrawal' as const,
      false,
      'RETURN_ORDER_NOT_RETURNABLE',
    ],
  ])('refuses refused for %s', async (_what, basis, sent, code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      if (sent) await ship(db, orderId);
      await asAdmin(db);
      return createReturn(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
        basis,
        reason: 'refused',
        statedAt: await paidAtOf(db, orderId),
      });
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it('refuses a parcel nothing of which is left to refuse (RETURN_ITEMS_REQUIRED)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await made(db, orderId, { items: [{ orderItemId: items[0]!.id, quantity: 1 }] });
      await ship(db, orderId);
      await asAdmin(db);
      return createReturn(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
        basis: 'withdrawal',
        reason: 'refused',
        statedAt: await paidAtOf(db, orderId),
      });
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEMS_REQUIRED'),
    });
  });

  it('cancels a shipped order only when the parcel is back and all the money with the delivery: not before', async () => {
    const steps = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      await ship(db, orderId);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 2 }],
        basis: 'withdrawal',
        reason: 'refused',
        statedAt: await paidAtOf(db, orderId),
      });
      await asAdmin(db);
      const onItsWay = await orderOf(db, orderId);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 2, goods: 'to_stock' }]);
      const back = await orderOf(db, orderId);
      const started = await db.attempt<{ done: { key: string } }>(
        `select cartlify.begin_return_refund($1::int, null, null) as done`,
        returnId,
      );
      if (!started.ok) throw new Error(started.message ?? 'refused');
      const paying = await orderOf(db, orderId);
      await db.rows(
        `select cartlify.settle_money_refund($1::text, 're_1', 'succeeded', null, null) as done`,
        started.rows[0]!.done.key,
      );
      return { onItsWay, back, paying, paid: await orderOf(db, orderId) };
    });

    expect(steps.onItsWay.status).toBe('shipped');
    expect(steps.back.status).toBe('shipped');
    expect(steps.paying.status).toBe('shipped');
    expect(steps.paid).toMatchObject({
      status: 'cancelled',
      cancelledAt: expect.any(String),
      returnStatus: 'full',
    });
  });

  it('wants the moment of the refusal from the admin (RETURN_STATED_AT_INVALID) and not before the send', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await ship(db, orderId);
      const paid = await paidAtOf(db, orderId);
      const item = [{ orderItemId: items[0]!.id, quantity: 1 }];
      const without = await createReturn(db, orderId, {
        items: item,
        basis: 'withdrawal',
        reason: 'refused',
      });
      // the send is an hour after the payment: a refusal at the payment is before it
      await db.rows(
        `insert into cartlify.order_shipments ("orderId", "shippedAt")
         values ($1, $2::timestamp + interval '1 hour') returning id`,
        orderId,
        paid,
      );
      const before = await createReturn(db, orderId, {
        items: item,
        basis: 'withdrawal',
        reason: 'refused',
        statedAt: paid,
      });
      return { without, before };
    });

    for (const outcome of [outcomes.without, outcomes.before]) {
      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_STATED_AT_INVALID'),
      });
    }
  });

  it('takes a parcel refused whatever is in it, though a withdrawal does not take such goods', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[perishable, 1]]);
      await ship(db, orderId);
      const item = [{ orderItemId: items[0]!.id, quantity: 1 }];
      const withdrawal = await createReturn(db, orderId, {
        items: item,
        basis: 'withdrawal',
        reason: 'goodwill',
      });
      const refused = await createReturn(db, orderId, {
        items: item,
        basis: 'withdrawal',
        reason: 'refused',
        statedAt: await paidAtOf(db, orderId),
      });
      return { withdrawal, refused };
    });

    expect(outcomes.withdrawal).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ITEM_NOT_RETURNABLE'),
    });
    expect(outcomes.refused.ok).toBe(true);
  });

  it('does not let the order become delivered while the statement of a refused parcel is open', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId } = await soldOrder(db, [[plain, 1]]);
      await ship(db, orderId);
      const delivered = () =>
        db.attempt(
          `update cartlify.orders set status = 'delivered' where id = $1 returning id`,
          orderId,
        );
      const free = await delivered();
      // back to shipped: the step back of an admin
      await asAdmin(db);
      await db.rows(
        `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
        orderId,
      );
      const [item] = await db.rows<{ id: number }>(
        `select id from cartlify.order_items where "orderId" = $1`,
        orderId,
      );
      await made(db, orderId, {
        items: [{ orderItemId: item!.id, quantity: 1 }],
        basis: 'withdrawal',
        reason: 'refused',
        statedAt: await paidAtOf(db, orderId),
      });
      await asAdmin(db);
      return { free, blocked: await delivered() };
    });

    expect(outcomes.free.ok).toBe(true);
    expect(outcomes.blocked).toMatchObject({
      ok: false,
      message: expect.stringContaining('ORDER_HAS_OPEN_REFUSAL'),
    });
  });

  it('cancels a shipped order that came back by any statement with all its money, not only by refused', async () => {
    const order = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await ship(db, orderId);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
      const started = await db.attempt<{ done: { key: string } }>(
        `select cartlify.begin_return_refund($1::int, null, null) as done`,
        returnId,
      );
      if (!started.ok) throw new Error(started.message ?? 'refused');
      await db.rows(
        `select cartlify.settle_money_refund($1::text, 're_1', 'succeeded', null, null) as done`,
        started.rows[0]!.done.key,
      );
      return orderOf(db, orderId);
    });

    expect(order).toMatchObject({ status: 'cancelled', returnStatus: 'full' });
  });

  it('leaves a delivered order delivered, whatever came back', async () => {
    const order = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await ship(db, orderId);
      await db.rows(
        `update cartlify.orders set status = 'delivered' where id = $1 returning id`,
        orderId,
      );
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]);
      return orderOf(db, orderId);
    });

    expect(order.status).toBe('delivered');
  });
});

describe('a statement of the buyer from their account', () => {
  const asBuyer = (db: DbSession) => db.as({ role: 'USER', userId: buyer.id });

  // the buyer's statement of withdrawal for the units of the item (the answers go to their email)
  const withdraw = (db: DbSession, orderId: number, itemId: number, quantity: number) =>
    createReturn(db, orderId, {
      items: [{ orderItemId: itemId, quantity }],
      source: 'account',
      basis: 'withdrawal',
      reason: null,
      description: 'I changed my mind.',
    });

  const ship = async (db: DbSession, orderId: number) => {
    await asAdmin(db);
    await db.rows(
      `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
      orderId,
    );
  };

  const proofOf = async (db: DbSession, returnId: number) => {
    await asAdmin(db);
    const [row] = await db.rows<{
      providedAt: string | null;
      carrier: string | null;
      number: string | null;
      url: string | null;
    }>(
      `select r.x::text as "providedAt", p.carrier, p."trackingNumber" as number, p."trackingUrl" as url
       from (select $1::int as id) as q
       left join cartlify.order_shipments as p on p."returnId" = q.id and p.direction = 'to_shop'
       cross join lateral (select p."shippedAt" as x) as r`,
      returnId,
    );
    return row!;
  };

  const provide = (
    db: DbSession,
    returnId: number,
    carrier: string | null = 'UPS',
    number: string | null = '1Z999AA10123456784',
    url: string | null = null,
  ) =>
    db.attempt(
      `select 1 as done from cartlify.provide_return_proof($1::int, $2::text, $3::text, $4::text)`,
      returnId,
      carrier,
      number,
      url,
    );

  it('brings the goods of a paid order back at once, and cancels the order when it is all of it', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      const stockBefore = await stockOf(db, admin.id, plain.variantId);
      await asBuyer(db);
      const outcome = await withdraw(db, orderId, items[0]!.id, 2);
      await asAdmin(db);
      const [order] = await db.rows<{ status: string }>(
        `select status::text as status from cartlify.orders where id = $1`,
        orderId,
      );
      const returnId = outcome.ok ? outcome.rows[0]!.id : 0;
      return {
        outcome,
        order: order!.status,
        rows: await rowsOf(db, returnId),
        head: await headOf(db, returnId),
        stockBefore,
        stockAfter: await stockOf(db, admin.id, plain.variantId),
      };
    });

    expect(result.outcome.ok).toBe(true);
    expect(result.rows).toEqual([expect.objectContaining({ goods: 'to_stock', quantity: 2 })]);
    expect(result.head).toMatchObject({ source: 'account', basis: 'withdrawal', reason: null });
    expect(result.order).toBe('cancelled');
    expect(result.stockAfter!.stock).toBe(result.stockBefore!.stock + 2);
  });

  it('brings back only the units named of a paid order and leaves the order paid', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 3]]);
      await asBuyer(db);
      const outcome = await withdraw(db, orderId, items[0]!.id, 1);
      await asAdmin(db);
      const [order] = await db.rows<{ status: string }>(
        `select status::text as status from cartlify.orders where id = $1`,
        orderId,
      );
      return { outcome, order: order!.status };
    });

    expect(result.outcome.ok).toBe(true);
    expect(result.order).toBe('paid');
  });

  it('waits for the parcel when the order was sent: the goods are not in the stock until the admin takes them in', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      await ship(db, orderId);
      const stockBefore = await stockOf(db, admin.id, plain.variantId);
      await asBuyer(db);
      const outcome = await withdraw(db, orderId, items[0]!.id, 2);
      await asAdmin(db);
      const returnId = outcome.ok ? outcome.rows[0]!.id : 0;
      return {
        rows: await rowsOf(db, returnId),
        stockBefore,
        stockAfter: await stockOf(db, admin.id, plain.variantId),
      };
    });

    expect(result.rows).toEqual([expect.objectContaining({ goods: 'expected' })]);
    expect(result.stockAfter).toEqual(result.stockBefore);
  });

  it('is refused for an order of another buyer (RETURN_ORDER_NOT_FOUND), as an admin could not state it as the buyer', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await db.as({ role: 'USER', userId: other.id });
      return withdraw(db, orderId, items[0]!.id, 1);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ORDER_NOT_FOUND'),
    });
  });

  it('records the carrier and the number of the parcel as the proof, and lets the buyer correct them until the admin confirms', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await ship(db, orderId);
      await asBuyer(db);
      const made = await withdraw(db, orderId, items[0]!.id, 1);
      const returnId = made.ok ? made.rows[0]!.id : 0;
      const first = await provide(db, returnId, 'UPS', '1Z-1', null);
      const second = await provide(db, returnId, 'DHL', '77', 'https://track.example.com/77');
      const proof = await proofOf(db, returnId);
      await asAdmin(db);
      await db.attempt(
        `select 1 as done from cartlify.confirm_return_proof($1::int, 0::numeric)`,
        returnId,
      );
      await asBuyer(db);
      return { first, second, proof, confirmed: await provide(db, returnId) };
    });

    expect(result.first.ok && result.second.ok).toBe(true);
    expect(result.proof).toMatchObject({
      providedAt: expect.any(String),
      carrier: 'DHL',
      number: '77',
      url: 'https://track.example.com/77',
    });
    expect(result.confirmed).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_PROOF_ALREADY_CONFIRMED'),
    });
  });

  it.each([
    ['no carrier', ['', '77', null], 'RETURN_PROOF_INVALID'],
    ['no number', ['UPS', '  ', null], 'RETURN_PROOF_INVALID'],
    [
      'a link that is not https',
      ['UPS', '77', 'http://track.example.com/77'],
      'RETURN_PROOF_INVALID',
    ],
    ['a link with spaces', ['UPS', '77', 'https://track.example.com/a b'], 'RETURN_PROOF_INVALID'],
  ] as const)('refuses a proof with %s (%s)', async (_what, [carrier, number, url], code) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await ship(db, orderId);
      await asBuyer(db);
      const made = await withdraw(db, orderId, items[0]!.id, 1);
      return provide(db, made.ok ? made.rows[0]!.id : 0, carrier, number, url);
    });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });

  it('keeps the proof for the buyer who made the statement: another buyer and an admin find none or are refused', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await ship(db, orderId);
      await asBuyer(db);
      const made = await withdraw(db, orderId, items[0]!.id, 1);
      const returnId = made.ok ? made.rows[0]!.id : 0;
      await db.as({ role: 'USER', userId: other.id });
      const stranger = await provide(db, returnId);
      await asAdmin(db);
      const byAdmin = await provide(db, returnId);
      return { stranger, byAdmin, proof: await proofOf(db, returnId) };
    });

    expect(outcomes.stranger).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_NOT_FOUND'),
    });
    expect(outcomes.byAdmin).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
    expect(outcomes.proof.providedAt).toBeNull();
  });

  it('has no proof to give for a statement whose goods are in already (RETURN_NOTHING_WAITING) or that is closed', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      // a paid order: the goods came back at once
      const paid = await soldOrder(db, [[plain, 2]]);
      await asBuyer(db);
      const back = await withdraw(db, paid.orderId, paid.items[0]!.id, 1);
      const nothing = await provide(db, back.ok ? back.rows[0]!.id : 0);
      // a sent order: root closes the row that never came
      const sent = await soldOrder(db, [[plain, 1]]);
      await ship(db, sent.orderId);
      await asBuyer(db);
      const waiting = await withdraw(db, sent.orderId, sent.items[0]!.id, 1);
      const waitingId = waiting.ok ? waiting.rows[0]!.id : 0;
      await db.as({ role: 'ROOT', userId: root.id });
      await db.attempt(
        `select cartlify.close_return_without_refund($1::int, null, 'other'::cartlify."ReturnCloseCode", 'x') as done`,
        waitingId,
      );
      await asBuyer(db);
      return { nothing, closed: await provide(db, waitingId) };
    });

    expect(outcomes.nothing).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_NOTHING_WAITING'),
    });
    expect(outcomes.closed).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_ALREADY_CLOSED'),
    });
  });
});

describe('a statement of the public form', () => {
  // the server acts by itself: nobody is signed in, the code of the order vouched for the buyer
  const asSystem = (db: DbSession) => db.as({ role: 'ADMIN' });

  const fromForm = (
    db: DbSession,
    source: 'form_code' | 'form_manual',
    orderId: number,
    itemId: number,
    quantity: number,
  ) =>
    createReturn(db, orderId, {
      items: [{ orderItemId: itemId, quantity }],
      source,
      basis: 'withdrawal',
      reason: null,
      name: 'Anna Koval',
      email: 'anna@example.com',
    });

  const ship = async (db: DbSession, orderId: number) => {
    await asAdmin(db);
    await db.rows(
      `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
      orderId,
    );
  };

  it('with the code brings the goods of a paid order back at once, in the name of the buyer of the order, and cancels it', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      const stockBefore = await stockOf(db, admin.id, plain.variantId);
      await asSystem(db);
      const outcome = await fromForm(db, 'form_code', orderId, items[0]!.id, 2);
      await asAdmin(db);
      const returnId = outcome.ok ? outcome.rows[0]!.id : 0;
      const [order] = await db.rows<{ status: string }>(
        `select status::text as status from cartlify.orders where id = $1`,
        orderId,
      );
      const [row] = await db.rows<{ author: number | null }>(
        `select "goodsSetById" as author from cartlify.return_items where "returnId" = $1`,
        returnId,
      );
      return {
        outcome,
        head: await headOf(db, returnId),
        order: order!.status,
        author: row!.author,
        rows: await rowsOf(db, returnId),
        stockBefore,
        stockAfter: await stockOf(db, admin.id, plain.variantId),
      };
    });

    expect(result.outcome.ok).toBe(true);
    // a form has no account: the statement names none, the result is the buyer's of the order
    expect(result.head).toMatchObject({ source: 'form_code', createdById: null, closedById: null });
    expect(result.author).toBe(buyer.id);
    expect(result.rows).toEqual([expect.objectContaining({ goods: 'to_stock' })]);
    expect(result.order).toBe('cancelled');
    expect(result.stockAfter!.stock).toBe(result.stockBefore!.stock + 2);
  });

  it('without the code waits for an admin: nothing is automatic, the order stays as it was', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      const stockBefore = await stockOf(db, admin.id, plain.variantId);
      await asSystem(db);
      const outcome = await fromForm(db, 'form_manual', orderId, items[0]!.id, 1);
      await asAdmin(db);
      const returnId = outcome.ok ? outcome.rows[0]!.id : 0;
      const [order] = await db.rows<{ status: string }>(
        `select status::text as status from cartlify.orders where id = $1`,
        orderId,
      );
      return {
        outcome,
        rows: await rowsOf(db, returnId),
        order: order!.status,
        stockBefore,
        stockAfter: await stockOf(db, admin.id, plain.variantId),
      };
    });

    expect(result.outcome.ok).toBe(true);
    expect(result.rows).toEqual([expect.objectContaining({ goods: 'expected' })]);
    expect(result.order).toBe('paid');
    expect(result.stockAfter).toEqual(result.stockBefore);
  });

  it('is made by the system only: a buyer and a visitor cannot pass for a form (RETURN_FORBIDDEN)', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      await db.as({ role: 'USER', userId: buyer.id });
      const byBuyer = await fromForm(db, 'form_code', orderId, items[0]!.id, 1);
      await db.as({ role: 'GUEST', guestId: '11111111-1111-4111-8111-111111111111' });
      return { byBuyer, byGuest: await fromForm(db, 'form_manual', orderId, items[0]!.id, 1) };
    });

    for (const outcome of [outcomes.byBuyer, outcomes.byGuest]) {
      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_FORBIDDEN'),
      });
    }
  });

  it('lets the system write the proof of a statement of a form with the code, and of an account, not of one without', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 3]]);
      await ship(db, orderId);
      await asSystem(db);
      const code = await fromForm(db, 'form_code', orderId, items[0]!.id, 1);
      const manual = await fromForm(db, 'form_manual', orderId, items[0]!.id, 1);
      const proof = (outcome: typeof code) =>
        db.attempt(
          `select 1 as done from cartlify.provide_return_proof($1::int, 'DHL', '77', null)`,
          outcome.ok ? outcome.rows[0]!.id : 0,
        );
      return { withCode: await proof(code), manual: await proof(manual) };
    });

    expect(outcomes.withCode.ok).toBe(true);
    expect(outcomes.manual).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_NOT_FOUND'),
    });
  });

  // a statement without the code holds its units only until the buyer states them: a statement of
  // the account or with the code takes them, the rows of the form give them up (not arrived, the
  // money refused, the code stated_again) and the rest of it waits on
  describe('over a statement without the code', () => {
    const codesOf = (db: DbSession, returnId: number) =>
      db.rows<{ quantity: number; goods: string; money: string; refusedCode: string | null }>(
        `select quantity, goods::text as goods, money::text as money,
                "refusedCode"::text as "refusedCode"
         from cartlify.return_items where "returnId" = $1 order by id`,
        returnId,
      );

    async function manualOf(db: DbSession, units: number) {
      const { orderId, items } = await soldOrder(db, [[plain, units]]);
      await ship(db, orderId);
      await asSystem(db);
      const manual = await fromForm(db, 'form_manual', orderId, items[0]!.id, units);
      if (!manual.ok) throw new Error(manual.message ?? 'refused');
      return { orderId, itemId: items[0]!.id, manualId: manual.rows[0]!.id };
    }

    it('with the code takes all its units, and the statement without the code is over', async () => {
      const result = await inRolledBackTx(async (db) => {
        const { orderId, itemId, manualId } = await manualOf(db, 2);
        await asSystem(db);
        const code = await fromForm(db, 'form_code', orderId, itemId, 2);
        await asAdmin(db);
        return {
          code,
          manual: await codesOf(db, manualId),
          head: await headOf(db, manualId),
          taken: code.ok ? await codesOf(db, code.rows[0]!.id) : [],
        };
      });

      expect(result.code.ok).toBe(true);
      expect(result.manual).toEqual([
        { quantity: 2, goods: 'not_arrived', money: 'refused', refusedCode: 'stated_again' },
      ]);
      // closed by its results, in the name of the context: the form has nobody signed in
      expect(result.head).toMatchObject({ closedAt: expect.any(String), closedById: null });
      expect(result.taken).toEqual([
        { quantity: 2, goods: 'expected', money: 'not_refunded', refusedCode: null },
      ]);
    });

    it('from the account takes what it needs past the free units, the rest of the form waits', async () => {
      const result = await inRolledBackTx(async (db) => {
        const { orderId, itemId, manualId } = await manualOf(db, 3);
        await db.as({ role: 'USER', userId: buyer.id });
        const own = await createReturn(db, orderId, {
          items: [{ orderItemId: itemId, quantity: 1 }],
          source: 'account',
          basis: 'withdrawal',
          reason: null,
        });
        await asAdmin(db);
        return { own, manual: await codesOf(db, manualId) };
      });

      expect(result.own.ok).toBe(true);
      expect(result.manual).toEqual([
        { quantity: 2, goods: 'expected', money: 'not_refunded', refusedCode: null },
        { quantity: 1, goods: 'not_arrived', money: 'refused', refusedCode: 'stated_again' },
      ]);
    });

    it('is not taken over by a statement of an admin: the units stay held (RETURN_QUANTITY_EXCEEDED)', async () => {
      const outcome = await inRolledBackTx(async (db) => {
        const { orderId, itemId } = await manualOf(db, 1);
        await asAdmin(db);
        return createReturn(db, orderId, { items: [{ orderItemId: itemId, quantity: 1 }] });
      });

      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_QUANTITY_EXCEEDED'),
      });
    });
    const accept = (db: DbSession, returnId: number) =>
      db.attempt(`select 1 as done from cartlify.accept_return($1::int)`, returnId);

    it('takes another statement without the code only once an admin accepted the first (RETURN_MANUAL_UNDER_REVIEW)', async () => {
      const outcomes = await inRolledBackTx(async (db) => {
        const { orderId, itemId, manualId } = await manualOf(db, 1);
        await asSystem(db);
        // the rule holds before any unit is counted: the units of the first are not the point
        const held = await fromForm(db, 'form_manual', orderId, itemId, 1);
        await asAdmin(db);
        const accepted = await accept(db, manualId);
        const [row] = await db.rows<{ acceptedAt: string | null; acceptedById: number | null }>(
          `select "acceptedAt"::text as "acceptedAt", "acceptedById" from cartlify.returns where id = $1`,
          manualId,
        );
        return { held, accepted, row };
      });

      expect(outcomes.held).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_MANUAL_UNDER_REVIEW'),
      });
      expect(outcomes.accepted.ok).toBe(true);
      expect(outcomes.row).toEqual({ acceptedAt: expect.any(String), acceptedById: admin.id });
    });

    it('takes the next statement without the code for the units left once the first is accepted', async () => {
      const outcome = await inRolledBackTx(async (db) => {
        const { orderId, items } = await soldOrder(db, [[plain, 2]]);
        await ship(db, orderId);
        await asSystem(db);
        const first = await fromForm(db, 'form_manual', orderId, items[0]!.id, 1);
        await asAdmin(db);
        await accept(db, first.ok ? first.rows[0]!.id : 0);
        await asSystem(db);
        return fromForm(db, 'form_manual', orderId, items[0]!.id, 1);
      });

      expect(outcome.ok).toBe(true);
    });

    it('does not take units over from a statement an admin accepted (RETURN_QUANTITY_EXCEEDED)', async () => {
      const outcome = await inRolledBackTx(async (db) => {
        const { orderId, itemId, manualId } = await manualOf(db, 1);
        await asAdmin(db);
        await accept(db, manualId);
        await asSystem(db);
        return fromForm(db, 'form_code', orderId, itemId, 1);
      });

      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_QUANTITY_EXCEEDED'),
      });
    });

    it('accepts once, an open statement of the form without the code only, by an admin', async () => {
      const outcomes = await inRolledBackTx(async (db) => {
        const { manualId } = await manualOf(db, 1);
        await db.as({ role: 'USER', userId: buyer.id });
        const byBuyer = await accept(db, manualId);
        await asAdmin(db);
        const first = await accept(db, manualId);
        const twice = await accept(db, manualId);
        const other = await soldOrder(db, [[plain, 1]]);
        const { returnId: byAdmin } = await made(db, other.orderId, {
          items: [{ orderItemId: other.items[0]!.id, quantity: 1 }],
        });
        await asAdmin(db);
        const notManual = await accept(db, byAdmin);
        const missing = await accept(db, 2_000_000_000);
        return { byBuyer, first, twice, notManual, missing };
      });

      expect(outcomes.first.ok).toBe(true);
      for (const [outcome, code] of [
        [outcomes.byBuyer, 'RETURN_FORBIDDEN'],
        [outcomes.twice, 'RETURN_ALREADY_ACCEPTED'],
        [outcomes.notManual, 'RETURN_NOT_MANUAL'],
        [outcomes.missing, 'RETURN_NOT_FOUND'],
      ] as const) {
        expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
      }
    });

    it('refuses to accept a statement that is closed (RETURN_ALREADY_CLOSED)', async () => {
      const outcome = await inRolledBackTx(async (db) => {
        const { manualId } = await manualOf(db, 1);
        await db.as({ role: 'ROOT', userId: root.id });
        await db.rows(
          `select cartlify.close_return_without_refund($1::int, null, 'not_buyer', 'Not the buyer.') as done`,
          manualId,
        );
        await asAdmin(db);
        return accept(db, manualId);
      });

      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_ALREADY_CLOSED'),
      });
    });

    it('holds the goods and the money of a statement without the code until it is accepted (RETURN_NOT_ACCEPTED)', async () => {
      const outcomes = await inRolledBackTx(async (db) => {
        const { manualId } = await manualOf(db, 1);
        const [row] = await rowsOf(db, manualId);
        await asAdmin(db);
        const steps = {
          receive: await receive(db, manualId, [
            { itemId: row!.id, quantity: 1, goods: 'to_stock' },
          ]),
          proof: await confirmProof(db, manualId),
          refund: await db.attempt(
            `select cartlify.begin_return_refund($1::int, null::int[], null::jsonb) as done`,
            manualId,
          ),
          parcel: await db.attempt(
            `select cartlify.record_return_shipment($1::int, 'DHL', null, null, 5, (now() at time zone 'UTC')::timestamp(3)) as id`,
            manualId,
          ),
        };
        await db.as({ role: 'ROOT', userId: root.id });
        const outside = await db.attempt(
          `select cartlify.mark_return_refunded_outside($1::int, null::int[], 'cash', 'Paid back.', (now() at time zone 'UTC')::timestamp(3), null::numeric) as done`,
          manualId,
        );
        await asAdmin(db);
        await accept(db, manualId);
        const after = await receive(db, manualId, [
          { itemId: row!.id, quantity: 1, goods: 'to_stock' },
        ]);
        return { ...steps, outside, after };
      });

      for (const outcome of [
        outcomes.receive,
        outcomes.proof,
        outcomes.refund,
        outcomes.parcel,
        outcomes.outside,
      ]) {
        expect(outcome).toMatchObject({
          ok: false,
          message: expect.stringContaining('RETURN_NOT_ACCEPTED'),
        });
      }
      expect(outcomes.after.ok).toBe(true);
    });
  });

  it('does not let an admin with an account write the proof of a buyer (RETURN_FORBIDDEN)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await ship(db, orderId);
      await asSystem(db);
      const code = await fromForm(db, 'form_code', orderId, items[0]!.id, 1);
      await asAdmin(db);
      return db.attempt(
        `select 1 as done from cartlify.provide_return_proof($1::int, 'DHL', '77', null)`,
        code.ok ? code.rows[0]!.id : 0,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
  });
});

describe('confirm_return_proof', () => {
  it('records who confirmed the proof of the buyer and when; an admin may confirm without a number', async () => {
    const head = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      await asAdmin(db);
      await confirmProof(db, returnId);
      return headOf(db, returnId);
    });

    expect(head.proofConfirmedAt).not.toBeNull();
    expect(head.proofConfirmedById).toBe(admin.id);
  });

  it('is done once (RETURN_PROOF_ALREADY_CONFIRMED), by an admin only (RETURN_FORBIDDEN)', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      await db.as({ role: 'USER', userId: buyer.id });
      const byBuyer = await confirmProof(db, returnId);
      await asAdmin(db);
      await confirmProof(db, returnId);
      return { byBuyer, again: await confirmProof(db, returnId) };
    });

    expect(outcomes.byBuyer).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
    expect(outcomes.again).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_PROOF_ALREADY_CONFIRMED'),
    });
  });

  it('is refused for a statement that is not there (RETURN_NOT_FOUND)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await asAdmin(db);
      return confirmProof(db, 2_147_483_000);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_NOT_FOUND'),
    });
  });
});

describe('who reads and who writes the rows', () => {
  it('lets the buyer read the statements and the rows of their own orders, an admin every one, and nobody else', async () => {
    const seen = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      const count = async (actor: Parameters<DbSession['as']>[0]) => {
        await db.as(actor);
        const [heads] = await db.rows<{ n: number }>(
          `select count(*)::int as n from cartlify.returns where id = $1`,
          returnId,
        );
        const [rows] = await db.rows<{ n: number }>(
          `select count(*)::int as n from cartlify.return_items where "returnId" = $1`,
          returnId,
        );
        return [heads!.n, rows!.n];
      };
      return {
        owner: await count({ role: 'USER', userId: buyer.id }),
        stranger: await count({ role: 'USER', userId: other.id }),
        admin: await count({ role: 'ADMIN', userId: admin.id }),
        guest: await count({ role: 'GUEST', guestId: '11111111-1111-4111-8111-111111111111' }),
      };
    });

    expect(seen).toEqual({ owner: [1, 1], stranger: [0, 0], admin: [1, 1], guest: [0, 0] });
  });

  it.each([
    [
      'inserts a statement',
      `insert into cartlify.returns ("orderId", source, basis, "contactName", "contactEmail", "statedAt") values ($1, 'admin', 'other', 'A', 'a@b.c', now()) returning id`,
    ],
    [
      'changes a statement',
      `update cartlify.returns set description = 'x' where "orderId" = $1 returning id`,
    ],
    [
      'changes the number of a statement',
      `update cartlify.returns set number = 99 where "orderId" = $1 returning id`,
    ],
    ['deletes a statement', `delete from cartlify.returns where "orderId" = $1 returning id`],
    [
      'changes a row',
      `update cartlify.return_items set quantity = 1, goods = 'to_stock' where "returnId" in (select id from cartlify.returns where "orderId" = $1) returning id`,
    ],
    [
      'deletes a row',
      `delete from cartlify.return_items where "returnId" in (select id from cartlify.returns where "orderId" = $1) returning id`,
    ],
    [
      'changes the units that went back',
      `update cartlify.order_batch_allocations set returned = 1 where "orderId" = $1 returning id`,
    ],
  ])('does not let an admin by a plain statement: %s', async (_what, statement) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      await made(db, orderId, { items: [{ orderItemId: items[0]!.id, quantity: 1 }] });
      await asAdmin(db);
      return db.attempt(statement, orderId);
    });

    expect(outcome.ok === false || outcome.rows.length === 0).toBe(true);
  });

  it.each([
    ['a user', () => ({ role: 'USER' as const, userId: buyer.id })],
    [
      'a guest',
      () => ({ role: 'GUEST' as const, guestId: '11111111-1111-4111-8111-111111111111' }),
    ],
  ])('does not let %s write any of these tables by a plain statement', async (_who, actor) => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      const snapshot = async () => {
        await asAdmin(db);
        return {
          head: await headOf(db, returnId),
          rows: await rowsOf(db, returnId),
          allocations: await allocationsOf(db, orderId),
          status: await statusOf(db, orderId),
        };
      };
      const before = await snapshot();
      await db.as(actor());
      const outcomes = [];
      for (const statement of [
        `update cartlify.returns set description = 'x' where "orderId" = $1 returning id`,
        `delete from cartlify.returns where "orderId" = $1 returning id`,
        `update cartlify.return_items set money = 'refunded' where "returnId" in (select id from cartlify.returns where "orderId" = $1) returning id`,
        `delete from cartlify.return_items where "returnId" in (select id from cartlify.returns where "orderId" = $1) returning id`,
        `update cartlify.order_batch_allocations set returned = 1 where "orderId" = $1 returning id`,
        `update cartlify.orders set "returnStatus" = 'full' where id = $1 returning id`,
        `insert into cartlify.returns ("orderId", source, basis, "contactName", "contactEmail", "statedAt") values ($1, 'account', 'withdrawal', 'A', 'a@b.c', now()) returning id`,
      ]) {
        outcomes.push(await db.attempt(statement, orderId));
      }
      return { outcomes, before, after: await snapshot() };
    });

    // a refusal or no row at all, and what was there is as it was
    for (const outcome of result.outcomes) {
      expect(outcome.ok === false || outcome.rows.length === 0).toBe(true);
    }
    expect(result.after).toEqual(result.before);
  });

  it('does not let the state of the order be written by hand', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { orderId } = await soldOrder(db, [[plain, 1]]);
      await asAdmin(db);
      return db.attempt(
        `update cartlify.orders set "returnStatus" = 'full' where id = $1 returning id`,
        orderId,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });
});

describe('the state of the order', () => {
  it('is none until a statement is made, then open, and declined when everything is refused', async () => {
    const states = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 1]]);
      const none = await statusOf(db, orderId);
      const { returnId } = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      const open = await statusOf(db, orderId);
      await asAdmin(db);
      const [row] = await rowsOf(db, returnId);
      await receive(db, returnId, [{ itemId: row!.id, quantity: 1, goods: 'not_arrived' }]);
      return { none, open, declined: await statusOf(db, orderId) };
    });

    expect(states).toEqual({ none: 'none', open: 'open', declined: 'declined' });
  });

  it('stays open while another statement of the order is open, though the first is over', async () => {
    const status = await inRolledBackTx(async (db) => {
      const { orderId, items } = await soldOrder(db, [[plain, 2]]);
      const first = await made(db, orderId, {
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
      });
      await made(db, orderId, { items: [{ orderItemId: items[0]!.id, quantity: 1 }] });
      await asAdmin(db);
      const [row] = await rowsOf(db, first.returnId);
      await receive(db, first.returnId, [{ itemId: row!.id, quantity: 1, goods: 'not_arrived' }]);
      return statusOf(db, orderId);
    });

    expect(status).toBe('open');
  });
});

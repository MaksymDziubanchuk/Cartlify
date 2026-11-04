import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { cartOf, waitingOrderOf } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the rule of withdrawal of a product: what the law lets a buyer do with it (it may be taken back
// freely, only sealed, or not at all). A product has its own rule or follows the nearest category
// above it that has one, and by default it may be taken back; one function reads the rule and where
// it came from. An item of an order keeps the rule of its product at the confirmation. All in
// transactions that roll back

type Rule = string;
type Found = { productId: number; rule: Rule; source: string; categoryId: number | null };

let buyer: TestUser;
let admin: TestUser;
// a branch: hygiene > middle (no rule) > leaf (no rule); mixed > mixedLeaf; a top category with none
let hygiene: { id: number };
let middle: { id: number };
let leaf: { id: number };
let mixed: { id: number };
let mixedLeaf: { id: number };
let bare: { id: number };
let own: TestProduct;
let inherits: TestProduct;
let nearest: TestProduct;
let byDefault: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });

  hygiene = await createCategory({ withdrawal: 'sealed_hygiene' });
  middle = await createCategory({ parentId: hygiene.id });
  leaf = await createCategory({ parentId: middle.id });
  mixed = await createCategory({ parentId: hygiene.id, withdrawal: 'mixed' });
  mixedLeaf = await createCategory({ parentId: mixed.id });
  bare = await createCategory();

  own = await createProduct({ categoryId: leaf.id, withdrawal: 'perishable' });
  inherits = await createProduct({ categoryId: leaf.id });
  nearest = await createProduct({ categoryId: mixedLeaf.id });
  byDefault = await createProduct({ categoryId: bare.id });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asAdminUser = (db: DbSession) => db.as({ role: 'ADMIN', userId: admin.id });

const ruleOf = async (db: DbSession, ...ids: number[]) =>
  db.rows<Found>(
    `select "productId", rule::text as rule, source, "categoryId"
     from cartlify.product_withdrawals($1::int[]) order by "productId"`,
    ids,
  );

describe('the rules of withdrawal', () => {
  it('are the seven the law has, in the order of the plan', async () => {
    const rows = await inRolledBackTx((db) =>
      db.rows<{ rule: string }>(
        `select unnest(enum_range(null::cartlify."WithdrawalRule"))::text as rule`,
      ),
    );

    expect(rows.map((row) => row.rule)).toEqual([
      'allowed',
      'sealed_hygiene',
      'sealed_media',
      'mixed',
      'perishable',
      'personalised',
      'periodical',
    ]);
  });
});

describe('product_withdrawals', () => {
  it('gives the rule a product has of its own, and says so', async () => {
    const [row] = await inRolledBackTx((db) => ruleOf(db, own.id));

    expect(row).toEqual({
      productId: own.id,
      rule: 'perishable',
      source: 'product',
      categoryId: null,
    });
  });

  it('gives a product with none the rule of the nearest category above it that has one', async () => {
    const rows = await inRolledBackTx((db) => ruleOf(db, inherits.id, nearest.id));

    expect(rows).toEqual(
      [
        {
          productId: inherits.id,
          rule: 'sealed_hygiene',
          source: 'category',
          categoryId: hygiene.id,
        },
        { productId: nearest.id, rule: 'mixed', source: 'category', categoryId: mixed.id },
      ].sort((a, b) => a.productId - b.productId),
    );
  });

  it('lets a product allow what its category refuses, and the other way round, by its own rule', async () => {
    const rows = await inRolledBackTx(async (db) => {
      await asAdminUser(db);
      await db.rows(
        `update cartlify.products set withdrawal = 'allowed' where id = $1 returning id`,
        inherits.id,
      );
      return ruleOf(db, inherits.id);
    });

    expect(rows).toEqual([
      { productId: inherits.id, rule: 'allowed', source: 'product', categoryId: null },
    ]);
  });

  it('is allowed when neither the product nor a category above it says anything', async () => {
    const [row] = await inRolledBackTx((db) => ruleOf(db, byDefault.id));

    expect(row).toEqual({
      productId: byDefault.id,
      rule: 'allowed',
      source: 'default',
      categoryId: null,
    });
  });

  it('follows a product that moves to another category, and a branch that moves', async () => {
    const { moved, branch } = await inRolledBackTx(async (db) => {
      await asAdminUser(db);
      await db.rows(
        `update cartlify.products set "categoryId" = $2 where id = $1 returning id`,
        inherits.id,
        mixedLeaf.id,
      );
      const moved = await ruleOf(db, inherits.id);
      // the leaf branch goes under the top category with no rule: its products follow the new parent
      await db.rows(
        `update cartlify.categories set "parentId" = $2 where id = $1 returning id`,
        middle.id,
        bare.id,
      );
      return { moved, branch: await ruleOf(db, byDefault.id, own.id) };
    });

    expect(moved[0]).toMatchObject({ rule: 'mixed', categoryId: mixed.id });
    const ruleFor = (id: number) => branch.find((row) => row.productId === id)?.rule;
    expect(ruleFor(byDefault.id)).toBe('allowed');
    expect(ruleFor(own.id)).toBe('perishable');
  });

  it('follows a category whose rule changes or is taken away', async () => {
    const { changed, cleared } = await inRolledBackTx(async (db) => {
      await asAdminUser(db);
      await db.rows(
        `update cartlify.categories set withdrawal = 'periodical' where id = $1 returning id`,
        hygiene.id,
      );
      const changed = await ruleOf(db, inherits.id);
      await db.rows(
        `update cartlify.categories set withdrawal = null where id = $1 returning id`,
        hygiene.id,
      );
      return { changed, cleared: await ruleOf(db, inherits.id) };
    });

    expect(changed[0]).toMatchObject({ rule: 'periodical', source: 'category' });
    expect(cleared[0]).toMatchObject({ rule: 'allowed', source: 'default' });
  });

  it('gives a row for each product asked, none for one that is not there', async () => {
    const rows = await inRolledBackTx((db) =>
      ruleOf(db, own.id, inherits.id, nearest.id, byDefault.id, 2_147_483_000),
    );

    expect(rows.map((row) => row.productId)).toEqual(
      [own.id, inherits.id, nearest.id, byDefault.id].sort((a, b) => a - b),
    );
  });

  it('gives the rule of a product that was taken out of the catalog, to a buyer too', async () => {
    const rows = await inRolledBackTx(async (db) => {
      await asAdminUser(db);
      await db.rows(
        `update cartlify.products set "deletedAt" = now() where id = $1 returning id`,
        inherits.id,
      );
      await db.as({ role: 'USER', userId: buyer.id });
      return ruleOf(db, inherits.id);
    });

    expect(rows).toEqual([
      {
        productId: inherits.id,
        rule: 'sealed_hygiene',
        source: 'category',
        categoryId: hygiene.id,
      },
    ]);
  });
});

describe('who sets a rule', () => {
  it.each([
    ['a product', 'products'],
    ['a category', 'categories'],
  ])('lets an admin set the rule of %s', async (_case, table) => {
    const id = table === 'products' ? own.id : leaf.id;
    const rows = await inRolledBackTx(async (db) => {
      await asAdminUser(db);
      return db.rows(
        `update cartlify.${table} set withdrawal = 'personalised' where id = $1 returning id`,
        id,
      );
    });

    expect(rows).toHaveLength(1);
  });

  it.each([
    ['a user', { role: 'USER' as const, userId: (): number | null => buyer.id }],
    ['a guest', { role: 'GUEST' as const, userId: (): number | null => null }],
  ])('does not let %s set the rule of a product or of a category', async (_case, who) => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as({ role: who.role, userId: who.userId() });
      const product = await db.attempt(
        `update cartlify.products set withdrawal = 'allowed' where id = $1 returning id`,
        own.id,
      );
      const category = await db.attempt(
        `update cartlify.categories set withdrawal = 'allowed' where id = $1 returning id`,
        leaf.id,
      );
      return [product, category];
    });

    for (const outcome of outcomes) {
      expect(outcome.ok === false || outcome.rows.length === 0).toBe(true);
    }
  });
});

type Kept = { withdrawal: Rule };

const keptOf = async (db: DbSession, orderId: number) => {
  await db.as({ role: 'USER', userId: buyer.id });
  return db.rows<Kept & { productId: number }>(
    `select "productId", withdrawal::text as withdrawal from cartlify.order_items
     where "orderId" = $1 order by "productId"`,
    orderId,
  );
};

describe('the rule an item of an order keeps', () => {
  it('is the rule of its product when the item is put into the cart', async () => {
    const kept = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, buyer.id, [
        [own.variantId, 1],
        [inherits.variantId, 1],
        [byDefault.variantId, 1],
      ]);
      return keptOf(db, orderId);
    });

    expect(kept).toEqual(
      [
        { productId: own.id, withdrawal: 'perishable' },
        { productId: inherits.id, withdrawal: 'sealed_hygiene' },
        { productId: byDefault.id, withdrawal: 'allowed' },
      ].sort((a, b) => a.productId - b.productId),
    );
  });

  it('is the rule at the confirmation, which the cart may have kept from before', async () => {
    const kept = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, buyer.id, [[inherits.variantId, 1]]);
      await asAdminUser(db);
      await db.rows(
        `update cartlify.categories set withdrawal = 'sealed_media' where id = $1 returning id`,
        hygiene.id,
      );
      const before = await keptOf(db, orderId);
      await db.as({ role: 'USER', userId: buyer.id });
      await db.rows(
        `select 1 as done from cartlify.confirm_order($1::int, '15 minutes'::interval, null, null, null)`,
        orderId,
      );
      return { before, after: await keptOf(db, orderId) };
    });

    expect(kept.before[0]!.withdrawal).toBe('sealed_hygiene');
    expect(kept.after[0]!.withdrawal).toBe('sealed_media');
  });

  it('does not change when the product or its category changes after the confirmation', async () => {
    const after = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, buyer.id, [
        [inherits.variantId, 1],
        [own.variantId, 1],
      ]);
      await asAdminUser(db);
      await db.rows(
        `update cartlify.categories set withdrawal = 'periodical' where id = $1 returning id`,
        hygiene.id,
      );
      await db.rows(
        `update cartlify.products set withdrawal = null where id = $1 returning id`,
        own.id,
      );
      return keptOf(db, orderId);
    });

    expect(after).toEqual(
      [
        { productId: inherits.id, withdrawal: 'sealed_hygiene' },
        { productId: own.id, withdrawal: 'perishable' },
      ].sort((a, b) => a.productId - b.productId),
    );
  });

  it('is not written by the buyer: the database sets it whatever the statement says', async () => {
    const kept = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, buyer.id, [[inherits.variantId, 1]]);
      await db.as({ role: 'USER', userId: buyer.id });
      await db.rows(
        `update cartlify.order_items set withdrawal = 'allowed', quantity = 2 where "orderId" = $1 returning id`,
        orderId,
      );
      return keptOf(db, orderId);
    });

    expect(kept[0]!.withdrawal).toBe('sealed_hygiene');
  });
});

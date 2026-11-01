import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  removeProducts,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// cartlify.variants_missing_required: one row for every live variant and every characteristic its
// category requires that the variant has no value of. What a category requires is its own set and
// those of its parents, the nearest category winning for a characteristic
// (cartlify.category_required_attributes). The admin list (missingRequired) and the alert
// (variants_missing_required) read it, so the rule lives only here. The tree, the products and the
// variants are made for good; the characteristics and the sets live in the rolled-back
// transaction of each test, so no other file sees them

let admin: TestUser;
let root: { id: number; products: TestProduct[] };
let child: { id: number; products: TestProduct[] };
let grandchild: { id: number; products: TestProduct[] };
const created: TestProduct[] = [];

beforeAll(async () => {
  admin = await createUser({ role: 'ADMIN' });

  const rootCategory = await createCategory();
  const childCategory = await createCategory({ parentId: rootCategory.id });
  const grandchildCategory = await createCategory({ parentId: childCategory.id });

  const make = async (categoryId: number) => {
    const product = await createProduct({ categoryId, stock: 0 });
    created.push(product);
    return { id: categoryId, products: [product] };
  };
  root = await make(rootCategory.id);
  child = await make(childCategory.id);
  grandchild = await make(grandchildCategory.id);
});

afterAll(async () => {
  try {
    await removeProducts(created);
    await closeSessions([admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const attributeOf = async (db: DbSession, name: string): Promise<number> => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const [group] = await db.rows<{ id: number }>(
    'insert into cartlify.attribute_groups (name, position) values ($1, $2) returning id',
    `Required group ${uniqueTag()}`,
    5_000_000 + Math.floor(Math.random() * 1_000_000),
  );
  const [attribute] = await db.rows<{ id: number }>(
    `insert into cartlify.attributes (name, type, "groupId", position)
     values ($1, 'text', $2, 1) returning id`,
    `${name} ${uniqueTag()}`,
    group!.id,
  );
  return attribute!.id;
};

const require_ = async (
  db: DbSession,
  categoryId: number,
  attributeId: number,
  required: boolean,
) => {
  await db.rows(
    `insert into cartlify.category_attributes ("categoryId", "attributeId", required)
     values ($1, $2, $3) returning "categoryId"`,
    categoryId,
    attributeId,
    required,
  );
};

const valueOf = async (db: DbSession, variantId: number, attributeId: number, text = 'x') => {
  await db.rows(
    `insert into cartlify.variant_attribute_values ("variantId", "attributeId", "textValue")
     values ($1, $2, $3) returning id`,
    variantId,
    attributeId,
    text,
  );
};

// the rows of the view for the variants of the test: [variant, characteristic]
const missingOf = async (db: DbSession, variantIds: number[]) => {
  const rows = await db.rows<{ variant_id: number; product_id: number; attribute_id: number }>(
    `select variant_id, product_id, attribute_id from cartlify.variants_missing_required
     where variant_id = any($1::int[]) order by variant_id, attribute_id`,
    variantIds,
  );
  return rows.map((row) => [row.variant_id, row.attribute_id]);
};

const requiredOf = async (db: DbSession, categoryIds: number[]) => {
  const rows = await db.rows<{ category_id: number; attribute_id: number }>(
    `select category_id, attribute_id from cartlify.category_required_attributes
     where category_id = any($1::int[]) order by category_id, attribute_id`,
    categoryIds,
  );
  return rows.map((row) => [row.category_id, row.attribute_id]);
};

describe('cartlify.variants_missing_required', () => {
  it('lists a variant that has no value of a characteristic its category requires', async () => {
    const found = await inRolledBackTx(async (db) => {
      const colour = await attributeOf(db, 'Colour');
      await require_(db, root.id, colour, true);
      return { colour, rows: await missingOf(db, [root.products[0]!.variantId]) };
    });

    expect(found.rows).toEqual([[root.products[0]!.variantId, found.colour]]);
  });

  it('does not list a variant that has the value', async () => {
    const rows = await inRolledBackTx(async (db) => {
      const colour = await attributeOf(db, 'Colour');
      await require_(db, root.id, colour, true);
      await valueOf(db, root.products[0]!.variantId, colour);
      return missingOf(db, [root.products[0]!.variantId]);
    });

    expect(rows).toEqual([]);
  });

  it('does not list a characteristic the category only offers', async () => {
    const rows = await inRolledBackTx(async (db) => {
      const colour = await attributeOf(db, 'Colour');
      await require_(db, root.id, colour, false);
      return missingOf(db, [root.products[0]!.variantId]);
    });

    expect(rows).toEqual([]);
  });

  it('lists a row for every characteristic missing, and none for one that is there', async () => {
    const found = await inRolledBackTx(async (db) => {
      const colour = await attributeOf(db, 'Colour');
      const size = await attributeOf(db, 'Size');
      const weight = await attributeOf(db, 'Material');
      await require_(db, root.id, colour, true);
      await require_(db, root.id, size, true);
      await require_(db, root.id, weight, true);
      await valueOf(db, root.products[0]!.variantId, size);
      return { colour, size, weight, rows: await missingOf(db, [root.products[0]!.variantId]) };
    });

    const variantId = root.products[0]!.variantId;
    expect(found.rows).toEqual(
      [
        [variantId, found.colour],
        [variantId, found.weight],
      ].sort((a, b) => a[1]! - b[1]!),
    );
    expect(found.rows.map((row) => row[1])).not.toContain(found.size);
  });

  it('asks of a child what its parents require', async () => {
    const found = await inRolledBackTx(async (db) => {
      const colour = await attributeOf(db, 'Colour');
      await require_(db, root.id, colour, true);
      return {
        colour,
        rows: await missingOf(db, [
          root.products[0]!.variantId,
          child.products[0]!.variantId,
          grandchild.products[0]!.variantId,
        ]),
        sets: await requiredOf(db, [root.id, child.id, grandchild.id]),
      };
    });

    expect(found.rows).toEqual([
      [root.products[0]!.variantId, found.colour],
      [child.products[0]!.variantId, found.colour],
      [grandchild.products[0]!.variantId, found.colour],
    ]);
    expect(found.sets).toEqual([
      [root.id, found.colour],
      [child.id, found.colour],
      [grandchild.id, found.colour],
    ]);
  });

  it('lets the setting of a child win over the one of its parent, for the child and below it', async () => {
    const found = await inRolledBackTx(async (db) => {
      const colour = await attributeOf(db, 'Colour');
      await require_(db, root.id, colour, true);
      // the child does not require it, so neither does the grandchild that names nothing
      await require_(db, child.id, colour, false);
      return {
        colour,
        rows: await missingOf(db, [
          root.products[0]!.variantId,
          child.products[0]!.variantId,
          grandchild.products[0]!.variantId,
        ]),
      };
    });

    expect(found.rows).toEqual([[root.products[0]!.variantId, found.colour]]);
  });

  it('lets the nearest category win: a grandchild may require what its parent does not', async () => {
    const found = await inRolledBackTx(async (db) => {
      const colour = await attributeOf(db, 'Colour');
      await require_(db, root.id, colour, true);
      await require_(db, child.id, colour, false);
      await require_(db, grandchild.id, colour, true);
      return {
        colour,
        rows: await missingOf(db, [
          root.products[0]!.variantId,
          child.products[0]!.variantId,
          grandchild.products[0]!.variantId,
        ]),
      };
    });

    expect(found.rows).toEqual([
      [root.products[0]!.variantId, found.colour],
      [grandchild.products[0]!.variantId, found.colour],
    ]);
  });

  it('asks nothing of a parent for what only its child requires', async () => {
    const found = await inRolledBackTx(async (db) => {
      const colour = await attributeOf(db, 'Colour');
      await require_(db, child.id, colour, true);
      return {
        colour,
        rows: await missingOf(db, [
          root.products[0]!.variantId,
          child.products[0]!.variantId,
          grandchild.products[0]!.variantId,
        ]),
        sets: await requiredOf(db, [root.id, child.id, grandchild.id]),
      };
    });

    expect(found.rows).toEqual([
      [child.products[0]!.variantId, found.colour],
      [grandchild.products[0]!.variantId, found.colour],
    ]);
    expect(found.sets.map((set) => set[0])).not.toContain(root.id);
  });

  it('skips a variant that is taken out of sale', async () => {
    const rows = await inRolledBackTx(async (db) => {
      const colour = await attributeOf(db, 'Colour');
      await require_(db, root.id, colour, true);
      await db.rows(
        `update cartlify.product_variants set "deletedAt" = now() at time zone 'utc'
         where id = $1 returning id`,
        root.products[0]!.variantId,
      );
      return missingOf(db, [root.products[0]!.variantId]);
    });

    expect(rows).toEqual([]);
  });

  it('skips the variants of a product that is removed from the catalog', async () => {
    const own = await createProduct({ categoryId: root.id, stock: 0 });
    created.push(own);
    await deleteProductFromCatalog(own.id);

    const rows = await inRolledBackTx(async (db) => {
      const colour = await attributeOf(db, 'Colour');
      await require_(db, root.id, colour, true);
      return missingOf(db, [own.variantId]);
    });

    expect(rows).toEqual([]);
  });

  it('names the product of the variant', async () => {
    const found = await inRolledBackTx(async (db) => {
      const colour = await attributeOf(db, 'Colour');
      await require_(db, root.id, colour, true);
      return db.rows<{ product_id: number }>(
        'select product_id from cartlify.variants_missing_required where variant_id = $1',
        root.products[0]!.variantId,
      );
    });

    expect(found).toEqual([{ product_id: root.products[0]!.id }]);
  });

  it('is read with the rights of its caller: the view runs as the invoker', async () => {
    const options = await inRolledBackTx((db) =>
      db.rows<{ name: string; reloptions: string[] | null; owner: string }>(
        `select c.relname as name, c.reloptions, pg_get_userbyid(c.relowner) as owner
         from pg_class c
         where c.relnamespace = 'cartlify'::regnamespace
           and c.relname in ('variants_missing_required', 'category_required_attributes')
         order by c.relname`,
      ),
    );

    expect(options).toEqual([
      {
        name: 'category_required_attributes',
        reloptions: ['security_invoker=true'],
        owner: 'cartlify_owner',
      },
      {
        name: 'variants_missing_required',
        reloptions: ['security_invoker=true'],
        owner: 'cartlify_owner',
      },
    ]);
  });
});

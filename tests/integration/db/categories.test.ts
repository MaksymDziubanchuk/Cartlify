import { afterAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { uniqueTag } from '../../helpers/factories.js';

// the tree of the categories goes from the top down: trg_categories_before_parent_change keeps a
// category from going inside its own branch, under itself or under any of its subcategories, at
// whatever depth. Any other move goes through: into another branch, to the top, back under a
// category that is no longer inside the moved one

afterAll(async () => {
  await prisma.$disconnect();
});

// Electronics > Phones > Smartphones > Flagships, and Accessories at the top
async function tree(db: DbSession) {
  await db.as({ role: 'ADMIN', userId: 1 });
  const tag = uniqueTag();
  const add = async (name: string, parentId: number | null) => {
    const [row] = await db.rows<{ id: number }>(
      'insert into cartlify.categories (name, slug, "parentId") values ($1, $2, $3) returning id',
      name,
      `${name.toLowerCase()}-${tag}`,
      parentId,
    );
    return row!.id;
  };

  const electronics = await add('Electronics', null);
  const phones = await add('Phones', electronics);
  const smartphones = await add('Smartphones', phones);
  const flagships = await add('Flagships', smartphones);
  const accessories = await add('Accessories', null);

  return { electronics, phones, smartphones, flagships, accessories };
}

const moveTo = (db: DbSession, id: number, parentId: number | null) =>
  db.attempt(
    'update cartlify.categories set "parentId" = $2 where id = $1 returning id',
    id,
    parentId,
  );

const parentOf = async (db: DbSession, id: number) =>
  (
    await db.rows<{ parentId: number | null }>(
      'select "parentId" from cartlify.categories where id = $1',
      id,
    )
  )[0]!.parentId;

describe('trg_categories_before_parent_change', () => {
  it.each([
    ['under itself', (t: Awaited<ReturnType<typeof tree>>) => [t.phones, t.phones]],
    ['under its child', (t: Awaited<ReturnType<typeof tree>>) => [t.phones, t.smartphones]],
    ['under its grandchild', (t: Awaited<ReturnType<typeof tree>>) => [t.phones, t.flagships]],
    [
      'the top under the bottom',
      (t: Awaited<ReturnType<typeof tree>>) => [t.electronics, t.flagships],
    ],
  ])('refuses a category %s and changes nothing', (_case, pick) =>
    inRolledBackTx(async (db) => {
      const t = await tree(db);
      const [id, parentId] = pick(t);
      const before = await parentOf(db, id!);

      const moved = await moveTo(db, id!, parentId!);

      expect(moved).toMatchObject({ ok: false, message: 'CATEGORY_PARENT_CYCLE' });
      expect(await parentOf(db, id!)).toBe(before);
    }),
  );

  it('refuses a new category made its own parent', () =>
    inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: 1 });
      const [{ id }] = (await db.rows<{ id: number }>(
        "select nextval(pg_get_serial_sequence('cartlify.categories', 'id'))::int as id",
      )) as [{ id: number }];

      const inserted = await db.attempt(
        'insert into cartlify.categories (id, name, slug, "parentId") values ($1, $2, $3, $1)',
        id,
        'Loop',
        `loop-${uniqueTag()}`,
      );

      expect(inserted).toMatchObject({ ok: false, message: 'CATEGORY_PARENT_CYCLE' });
    }));

  it('moves a category with its branch into another branch and to the top', () =>
    inRolledBackTx(async (db) => {
      const t = await tree(db);

      expect(await moveTo(db, t.phones, t.accessories)).toMatchObject({ ok: true });
      expect(await moveTo(db, t.flagships, null)).toMatchObject({ ok: true });

      expect(await parentOf(db, t.phones)).toBe(t.accessories);
      // the branch went with it
      expect(await parentOf(db, t.smartphones)).toBe(t.phones);
      expect(await parentOf(db, t.flagships)).toBeNull();
    }));

  // the rule looks at the tree as it is: once a category is out of the branch, it can take it in
  it('lets a category go under one that was inside it once it is out of its branch', () =>
    inRolledBackTx(async (db) => {
      const t = await tree(db);

      expect(await moveTo(db, t.smartphones, t.electronics)).toMatchObject({ ok: true });
      expect(await moveTo(db, t.phones, t.flagships)).toMatchObject({ ok: true });

      expect(await parentOf(db, t.phones)).toBe(t.flagships);
    }));

  it('lets every other field of a category change', () =>
    inRolledBackTx(async (db) => {
      const t = await tree(db);

      const renamed = await db.attempt(
        'update cartlify.categories set name = $2 where id = $1 returning id',
        t.phones,
        'Mobile phones',
      );

      expect(renamed).toMatchObject({ ok: true });
    }));
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { changedRows } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';

// the directory of the characteristics a variant is described by: groups, characteristics, the
// values of a choice, and the characteristics a category asks for. Everybody reads, only an admin
// or a root writes; the names, the places, the settings of a number and the main ones are held by
// the database

let user: TestUser;
let admin: TestUser;
let root: TestUser;
let categoryId: number;

beforeAll(async () => {
  user = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  categoryId = (await createProduct({ stock: 0 })).categoryId;
});

afterAll(async () => {
  try {
    await closeSessions([user.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asUser = (): Actor => ({ role: 'USER', userId: user.id });
const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });
const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });
const asGuest = (): Actor => ({ role: 'GUEST', guestId: randomUUID() });

const codeOf = (outcome: { ok: boolean; code?: string | null }) =>
  outcome.ok ? 'done' : (outcome.code ?? 'failed');

// the places of a test are far from the ones of the other files of the run, which share the table
let place = 1_000_000;
const nextPlace = () => ++place;

const insertGroup = (db: DbSession, name = `Group ${uniqueTag()}`, position = nextPlace()) =>
  db.attempt<{ id: number }>(
    'insert into cartlify.attribute_groups (name, position) values ($1, $2) returning id',
    name,
    position,
  );

async function aGroup(db: DbSession): Promise<number> {
  await db.as(asAdmin());
  const made = await insertGroup(db);
  return made.ok ? made.rows[0]!.id : 0;
}

type AttributeOver = {
  name?: string;
  type?: string;
  unit?: string | null;
  position?: number;
  isMain?: boolean;
  decimals?: number | null;
  min?: number | null;
  max?: number | null;
};

const insertAttribute = (db: DbSession, groupId: number, over: AttributeOver = {}) => {
  const type = over.type ?? 'text';
  return db.attempt<{ id: number }>(
    `insert into cartlify.attributes (name, type, unit, "groupId", position, "isMain", decimals, "minValue", "maxValue")
     values ($1, $2::cartlify."AttributeType", $3, $4, $5, $6, $7, $8, $9) returning id`,
    over.name ?? `Attribute ${uniqueTag()}`,
    type,
    over.unit ?? null,
    groupId,
    over.position ?? nextPlace(),
    over.isMain ?? false,
    over.decimals === undefined ? (type === 'number' ? 0 : null) : over.decimals,
    over.min ?? null,
    over.max ?? null,
  );
};

async function anAttribute(
  db: DbSession,
  type = 'option',
): Promise<{ groupId: number; id: number }> {
  const groupId = await aGroup(db);
  const made = await insertAttribute(db, groupId, { type });
  return { groupId, id: made.ok ? made.rows[0]!.id : 0 };
}

const insertOption = (
  db: DbSession,
  attributeId: number,
  over: { name?: string; position?: number; colorCode?: string | null } = {},
) =>
  db.attempt<{ id: number }>(
    `insert into cartlify.attribute_options ("attributeId", name, position, "colorCode")
     values ($1, $2, $3, $4) returning id`,
    attributeId,
    over.name ?? `Value ${uniqueTag()}`,
    over.position ?? nextPlace(),
    over.colorCode ?? null,
  );

describe('the directory of characteristics', () => {
  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
  ])('let %s read every table of it', async (_who, actor) => {
    const seen = await inRolledBackTx(async (db) => {
      const { id: attributeId } = await anAttribute(db);
      const option = await insertOption(db, attributeId);
      await db.rows(
        'insert into cartlify.category_attributes ("categoryId", "attributeId", required) values ($1, $2, true)',
        categoryId,
        attributeId,
      );
      await db.as(actor());
      return {
        attribute: await db.rows('select id from cartlify.attributes where id = $1', attributeId),
        option: await db.rows(
          'select id from cartlify.attribute_options where "attributeId" = $1',
          attributeId,
        ),
        asked: await db.rows(
          'select "attributeId" from cartlify.category_attributes where "attributeId" = $1',
          attributeId,
        ),
        optionId: option.ok ? option.rows[0]!.id : 0,
        attributeId,
      };
    });

    expect(seen.attribute).toEqual([{ id: seen.attributeId }]);
    expect(seen.option).toEqual([{ id: seen.optionId }]);
    expect(seen.asked).toEqual([{ attributeId: seen.attributeId }]);
  });

  it.each([
    ['an admin', asAdmin],
    ['a root', asRoot],
  ])(
    'let %s create, change and delete a group, a characteristic and a value',
    async (_who, actor) => {
      const outcomes = await inRolledBackTx(async (db) => {
        await db.as(actor());
        const group = await insertGroup(db);
        const groupId = group.ok ? group.rows[0]!.id : 0;
        const attribute = await insertAttribute(db, groupId, { type: 'option' });
        const attributeId = attribute.ok ? attribute.rows[0]!.id : 0;
        const option = await insertOption(db, attributeId);
        const optionId = option.ok ? option.rows[0]!.id : 0;
        return [
          group,
          attribute,
          option,
          await db.attempt(
            `update cartlify.attribute_options set name = 'Renamed', "colorCode" = '#00ff00' where id = $1 returning id`,
            optionId,
          ),
          await db.attempt(
            `update cartlify.attributes set unit = 'mm' where id = $1 returning id`,
            attributeId,
          ),
          await db.attempt(
            `update cartlify.attribute_groups set name = 'Renamed' where id = $1 returning id`,
            groupId,
          ),
          await db.attempt(
            'delete from cartlify.attribute_options where id = $1 returning id',
            optionId,
          ),
          await db.attempt(
            'delete from cartlify.attributes where id = $1 returning id',
            attributeId,
          ),
          await db.attempt(
            'delete from cartlify.attribute_groups where id = $1 returning id',
            groupId,
          ),
        ];
      });

      expect(outcomes.map(changedRows)).toEqual(Array(9).fill(true));
    },
  );

  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
  ])('let %s create, change or delete none', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { id: attributeId, groupId } = await anAttribute(db);
      const option = await insertOption(db, attributeId);
      const optionId = option.ok ? option.rows[0]!.id : 0;
      await db.as(actor());
      return [
        await insertGroup(db),
        await insertAttribute(db, groupId, { type: 'text' }),
        await insertOption(db, attributeId),
        await db.attempt(
          `update cartlify.attribute_groups set name = 'X' where id = $1 returning id`,
          groupId,
        ),
        await db.attempt(
          `update cartlify.attributes set unit = 'x' where id = $1 returning id`,
          attributeId,
        ),
        await db.attempt(
          `update cartlify.attribute_options set name = 'X' where id = $1 returning id`,
          optionId,
        ),
        await db.attempt(
          'delete from cartlify.attribute_options where id = $1 returning id',
          optionId,
        ),
        await db.attempt('delete from cartlify.attributes where id = $1 returning id', attributeId),
        await db.attempt(
          'delete from cartlify.attribute_groups where id = $1 returning id',
          groupId,
        ),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual(Array(9).fill(false));
  });

  it('keep the id and the day of a row and the characteristic of a value as they were made', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { id: attributeId, groupId } = await anAttribute(db);
      const other = await anAttribute(db);
      const option = await insertOption(db, attributeId);
      const optionId = option.ok ? option.rows[0]!.id : 0;
      const run = (table: string, id: number, set: string) =>
        db.attempt(`update cartlify.${table} set ${set} where id = $1 returning id`, id);
      return [
        await run('attribute_groups', groupId, 'id = id + 1000000'),
        await run('attribute_groups', groupId, `"createdAt" = now() - interval '1 year'`),
        await run('attributes', attributeId, 'id = id + 1000000'),
        await run('attributes', attributeId, `"createdAt" = now() - interval '1 year'`),
        await run('attribute_options', optionId, `"attributeId" = ${other.id}`),
        await run('attribute_options', optionId, `"createdAt" = now() - interval '1 year'`),
        // what may change
        await run('attribute_groups', groupId, `name = 'Other', "updatedAt" = now()`),
        await run('attributes', attributeId, `name = 'Other', "updatedAt" = now()`),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual([
      '42501',
      '42501',
      '42501',
      '42501',
      '42501',
      '42501',
      'done',
      'done',
    ]);
  });

  it('refuse a name that is empty, padded or over 100 signs in a group, a characteristic and a value', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { id: attributeId, groupId } = await anAttribute(db);
      await db.as(asAdmin());
      const results = [];
      for (const name of ['', ' Padded', 'Padded ', 'x'.repeat(101)]) {
        results.push(await insertGroup(db, name));
        results.push(await insertAttribute(db, groupId, { name }));
        results.push(await insertOption(db, attributeId, { name }));
      }
      return results;
    });

    expect(outcomes.map(codeOf)).toEqual(Array(12).fill('23514'));
  });

  it('take a name of 100 signs and a unit of up to 20, and refuse a unit empty, padded or longer', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const groupId = await aGroup(db);
      return [
        await insertAttribute(db, groupId, { name: 'x'.repeat(100), unit: 'u'.repeat(20) }),
        await insertAttribute(db, groupId, { unit: '' }),
        await insertAttribute(db, groupId, { unit: ' mm' }),
        await insertAttribute(db, groupId, { unit: 'u'.repeat(21) }),
        await insertAttribute(db, groupId, { position: 0 }),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', '23514', '23514', '23514', '23514']);
  });

  it('keep the settings of a number with a number only: digits after the point, bounds in order', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const groupId = await aGroup(db);
      return [
        // a number has its digits, bounds are free
        await insertAttribute(db, groupId, { type: 'number', decimals: 3, min: 1, max: 120 }),
        await insertAttribute(db, groupId, { type: 'number', decimals: 0 }),
        // a number without its digits, with 4, with bounds the wrong way round
        await insertAttribute(db, groupId, { type: 'number', decimals: null }),
        await insertAttribute(db, groupId, { type: 'number', decimals: 4 }),
        await insertAttribute(db, groupId, { type: 'number', decimals: 1, min: 5, max: 1 }),
        // digits or bounds on what is no number
        await insertAttribute(db, groupId, { type: 'text', decimals: 1 }),
        await insertAttribute(db, groupId, { type: 'option', min: 1 }),
        await insertAttribute(db, groupId, { type: 'boolean', max: 1 }),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual([
      'done',
      'done',
      '23514',
      '23514',
      '23514',
      '23514',
      '23514',
      '23514',
    ]);
  });

  it('let only a choice, a number and yes/no be a main characteristic', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const groupId = await aGroup(db);
      const main = (type: string) => insertAttribute(db, groupId, { type, isMain: true });
      return [
        await main('option'),
        await main('number'),
        await main('boolean'),
        await main('text'),
        await main('options'),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', 'done', 'done', '23514', '23514']);
  });

  it('take the colour of a value as #RRGGBB and refuse any other', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { id } = await anAttribute(db);
      return [
        await insertOption(db, id, { colorCode: '#00FF7f' }),
        await insertOption(db, id, { colorCode: null }),
        await insertOption(db, id, { colorCode: '00ff00' }),
        await insertOption(db, id, { colorCode: '#0f0' }),
        await insertOption(db, id, { colorCode: '#00gg00' }),
        await insertOption(db, id, { colorCode: 'red' }),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', 'done', '23514', '23514', '23514', '23514']);
  });

  it('keep one name once in its scope, letter case ignored', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const tag = uniqueTag();
      const first = await anAttribute(db);
      const second = await anAttribute(db);
      return [
        // a group name is one in the whole directory
        await insertGroup(db, `Same ${tag}`),
        await insertGroup(db, `SAME ${tag}`),
        // a characteristic name too, in whichever group
        await insertAttribute(db, first.groupId, { name: `Name ${tag}` }),
        await insertAttribute(db, second.groupId, { name: `NAME ${tag}` }),
        // a value name is one in its characteristic, the same name may stand in another
        await insertOption(db, first.id, { name: `Black ${tag}` }),
        await insertOption(db, first.id, { name: `BLACK ${tag}` }),
        await insertOption(db, second.id, { name: `Black ${tag}` }),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual([
      'done',
      '23505',
      'done',
      '23505',
      'done',
      '23505',
      'done',
    ]);
  });

  // the places are checked at the end of the transaction, so a new order is written row by row
  it('check the places once, at the end: a swap passes, a place twice does not', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { id: attributeId } = await anAttribute(db);
      const first = await insertOption(db, attributeId, { position: 1 });
      const second = await insertOption(db, attributeId, { position: 2 });
      const [a, b] = [first.ok ? first.rows[0]!.id : 0, second.ok ? second.rows[0]!.id : 0];
      const set = (id: number, position: number) =>
        db.attempt(
          'update cartlify.attribute_options set position = $2 where id = $1 returning id',
          id,
          position,
        );

      const swapped = [await set(a, 2), await set(b, 1)];
      const swapCheck = await db.attempt('set constraints all immediate');
      // the check stays immediate to the end of the transaction unless it is put off again
      const deferAgain = await db.attempt('set constraints all deferred');
      const doubled = await set(a, 5);
      const doubledToo = await set(b, 5);
      const doubleCheck = await db.attempt('set constraints all immediate');
      return [...swapped, swapCheck, deferAgain, doubled, doubledToo, doubleCheck];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', '23505']);
  });

  it('refuse to delete a group that has characteristics, and delete the values with their characteristic', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { id: attributeId, groupId } = await anAttribute(db);
      await insertOption(db, attributeId);
      const group = await db.attempt(
        'delete from cartlify.attribute_groups where id = $1 returning id',
        groupId,
      );
      const attribute = await db.attempt(
        'delete from cartlify.attributes where id = $1 returning id',
        attributeId,
      );
      const left = await db.rows<{ n: number }>(
        'select count(*)::int as n from cartlify.attribute_options where "attributeId" = $1',
        attributeId,
      );
      return { group, attribute, left: left[0]!.n };
    });

    expect(codeOf(outcomes.group)).toBe('23503');
    expect(codeOf(outcomes.attribute)).toBe('done');
    expect(outcomes.left).toBe(0);
  });
});

describe('the characteristics of a category', () => {
  const ask = (db: DbSession, attributeId: number, required = false) =>
    db.attempt(
      `insert into cartlify.category_attributes ("categoryId", "attributeId", required)
       values ($1, $2, $3) returning "attributeId"`,
      categoryId,
      attributeId,
      required,
    );

  it('let an admin ask for a characteristic, once, and take the row away', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { id } = await anAttribute(db);
      return [
        await ask(db, id, true),
        await ask(db, id),
        await db.attempt(
          'delete from cartlify.category_attributes where "attributeId" = $1 returning "attributeId"',
          id,
        ),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', '23505', 'done']);
  });

  it('let a user ask for none and take none away', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const { id } = await anAttribute(db);
      await ask(db, id);
      await db.as(asUser());
      return [
        await ask(db, id + 1),
        await db.attempt(
          'delete from cartlify.category_attributes where "attributeId" = $1 returning "attributeId"',
          id,
        ),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([false, false]);
  });

  it('never change a row: there is no policy to update one', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { id } = await anAttribute(db);
      await ask(db, id);
      return db.attempt(
        'update cartlify.category_attributes set required = true where "attributeId" = $1 returning required',
        id,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it('keep a characteristic a category asks for: it cannot be deleted, and the row goes with its category', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { id } = await anAttribute(db);
      await ask(db, id);
      const refused = await db.attempt(
        'delete from cartlify.attributes where id = $1 returning id',
        id,
      );

      const tag = uniqueTag();
      const [category] = await db.rows<{ id: number }>(
        'insert into cartlify.categories (name, slug) values ($1, $2) returning id',
        `Cat ${tag}`,
        `cat-${tag}`,
      );
      await db.rows(
        'insert into cartlify.category_attributes ("categoryId", "attributeId") values ($1, $2)',
        category!.id,
        id,
      );
      await db.attempt('delete from cartlify.categories where id = $1 returning id', category!.id);
      const left = await db.rows<{ n: number }>(
        'select count(*)::int as n from cartlify.category_attributes where "categoryId" = $1',
        category!.id,
      );
      return { refused, left: left[0]!.n };
    });

    expect(codeOf(outcome.refused)).toBe('23503');
    expect(outcome.left).toBe(0);
  });
});

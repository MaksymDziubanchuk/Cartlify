import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { changedRows } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createUser,
  defaultPartyId,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';

// the values of the characteristics a variant has (db/03, db/05, db/06) and the names they make
// (cartlify.variant_names): one row for a value, kept within the type of its characteristic, and one
// rule that turns the values that tell the variants of a product apart into the name of a variant.
// Everything is made in the rolled-back transaction of its test

let user: TestUser;
let admin: TestUser;
let root: TestUser;

beforeAll(async () => {
  user = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
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
const messageOf = (outcome: { ok: boolean; message?: string | null }) =>
  outcome.ok ? 'done' : (outcome.message ?? 'failed');

// places far from the ones of the other files of the run, which share the tables
let place = 3_000_000;
const nextPlace = () => ++place;

type Attr = { id: number; type: string };

async function aGroup(db: DbSession, position = nextPlace()): Promise<number> {
  const [row] = await db.rows<{ id: number }>(
    'insert into cartlify.attribute_groups (name, position) values ($1, $2) returning id',
    `Values group ${uniqueTag()}`,
    position,
  );
  return row!.id;
}

type AttrOver = {
  name?: string;
  unit?: string | null;
  isMain?: boolean;
  decimals?: number;
  min?: number;
  max?: number;
  groupId?: number;
  position?: number;
};

async function anAttribute(db: DbSession, type: string, over: AttrOver = {}): Promise<Attr> {
  const groupId = over.groupId ?? (await aGroup(db));
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.attributes (name, type, unit, "groupId", position, "isMain", decimals, "minValue", "maxValue")
     values ($1, $2::cartlify."AttributeType", $3, $4, $5, $6, $7, $8, $9) returning id`,
    over.name ?? `Characteristic ${uniqueTag()}`,
    type,
    over.unit ?? null,
    groupId,
    over.position ?? nextPlace(),
    over.isMain ?? false,
    type === 'number' ? (over.decimals ?? 0) : null,
    type === 'number' ? (over.min ?? null) : null,
    type === 'number' ? (over.max ?? null) : null,
  );
  return { id: row!.id, type };
}

async function anOption(
  db: DbSession,
  attribute: Attr,
  name = `Value ${uniqueTag()}`,
  position = nextPlace(),
): Promise<number> {
  const [row] = await db.rows<{ id: number }>(
    'insert into cartlify.attribute_options ("attributeId", name, position) values ($1, $2, $3) returning id',
    attribute.id,
    name,
    position,
  );
  return row!.id;
}

// a product of its own with one picture in the gallery; the variants are made by aVariant
async function aProduct(db: DbSession) {
  await db.as(asAdmin());
  const tag = uniqueTag();
  const [category] = await db.rows<{ id: number }>(
    'insert into cartlify.categories (name, slug) values ($1, $2) returning id',
    `Values category ${tag}`,
    `values-category-${tag}`,
  );
  const name = `Values product ${tag}`;
  const [product] = await db.rows<{ id: number }>(
    `insert into cartlify.products (name, "categoryId", "manufacturerId") values ($1, $2, $3) returning id`,
    name,
    category!.id,
    await defaultPartyId(),
  );
  const [image] = await db.rows<{ id: number }>(
    `insert into cartlify.product_images ("productId", url, position)
     values ($1, 'https://res.cloudinary.com/demo/image/upload/v1/test/v.jpg', 0) returning id`,
    product!.id,
  );
  return { productId: product!.id, imageId: image!.id, name };
}

let variantPlace = 1;

// a variant of the product; visible ones show the picture of the gallery
async function aVariant(
  db: DbSession,
  product: { productId: number; imageId: number },
  opts: { visible?: boolean; deleted?: boolean } = {},
): Promise<number> {
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.product_variants ("productId", position, price, "deletedAt")
     values ($1, $2, 10, $3) returning id`,
    product.productId,
    variantPlace++,
    opts.deleted ? new Date() : null,
  );
  if (opts.visible ?? true) {
    await db.rows(
      'insert into cartlify.variant_images ("variantId", "imageId", position) values ($1, $2, 1) returning id',
      row!.id,
      product.imageId,
    );
  }
  return row!.id;
}

type Value = {
  text?: string | null;
  number?: number | string | null;
  bool?: boolean | null;
  optionId?: number | null;
};

const putValue = (db: DbSession, variantId: number, attribute: Attr, value: Value) =>
  db.attempt<{ id: number }>(
    `insert into cartlify.variant_attribute_values ("variantId", "attributeId", "textValue", "numberValue", "boolValue", "optionId")
     values ($1, $2, $3, $4::numeric, $5, $6) returning id`,
    variantId,
    attribute.id,
    value.text ?? null,
    value.number === undefined || value.number === null ? null : String(value.number),
    value.bool ?? null,
    value.optionId ?? null,
  );

// a value that has to be made
async function set(db: DbSession, variantId: number, attribute: Attr, value: Value) {
  const made = await putValue(db, variantId, attribute, value);
  if (!made.ok) throw new Error(`value refused: ${made.message}`);
}

type NameRow = { variant_id: number; name: string; values: unknown };

const namesOf = async (db: DbSession, ids: number[]) =>
  new Map(
    (
      await db.rows<NameRow>(
        'select variant_id, name, "values" from cartlify.variant_names($1::int[])',
        ids,
      )
    ).map((row) => [row.variant_id, row]),
  );

const nameOf = async (db: DbSession, variantId: number) =>
  (await namesOf(db, [variantId])).get(variantId)!.name;

const DASH = String.fromCharCode(8212);

describe('variant_attribute_values: who reads and writes', () => {
  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
    ['an admin', asAdmin],
    ['a root', asRoot],
  ])('let %s read the values', async (_who, actor) => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const variantId = await aVariant(db, product);
      const attribute = await anAttribute(db, 'text');
      await set(db, variantId, attribute, { text: 'Matte' });
      await db.as(actor());
      return db.rows(
        'select "textValue" from cartlify.variant_attribute_values where "variantId" = $1',
        variantId,
      );
    });

    expect(found).toEqual([{ textValue: 'Matte' }]);
  });

  it.each([
    ['an admin', asAdmin],
    ['a root', asRoot],
  ])('let %s make, change and delete a value', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const variantId = await aVariant(db, product);
      const attribute = await anAttribute(db, 'text');
      await db.as(actor());
      const made = await putValue(db, variantId, attribute, { text: 'One' });
      const id = made.ok ? made.rows[0]!.id : 0;
      return [
        made,
        await db.attempt(
          `update cartlify.variant_attribute_values set "textValue" = 'Two' where id = $1 returning id`,
          id,
        ),
        await db.attempt(
          'delete from cartlify.variant_attribute_values where id = $1 returning id',
          id,
        ),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([true, true, true]);
  });

  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
  ])('let %s make, change or delete none', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const variantId = await aVariant(db, product);
      const attribute = await anAttribute(db, 'text');
      const other = await anAttribute(db, 'text');
      await set(db, variantId, attribute, { text: 'One' });
      const [row] = await db.rows<{ id: number }>(
        'select id from cartlify.variant_attribute_values where "variantId" = $1',
        variantId,
      );
      await db.as(actor());
      return [
        await putValue(db, variantId, other, { text: 'x' }),
        await db.attempt(
          `update cartlify.variant_attribute_values set "textValue" = 'Two' where id = $1 returning id`,
          row!.id,
        ),
        await db.attempt(
          'delete from cartlify.variant_attribute_values where id = $1 returning id',
          row!.id,
        ),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([false, false, false]);
  });

  it('keep the variant and the characteristic of a row as they were made, and change the value only', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const first = await aVariant(db, product);
      const second = await aVariant(db, product);
      const attribute = await anAttribute(db, 'text');
      const other = await anAttribute(db, 'text');
      await set(db, first, attribute, { text: 'One' });
      const [row] = await db.rows<{ id: number }>(
        'select id from cartlify.variant_attribute_values where "variantId" = $1',
        first,
      );
      await db.as(asAdmin());
      const run = (setClause: string) =>
        db.attempt(
          `update cartlify.variant_attribute_values set ${setClause} where id = $1 returning id`,
          row!.id,
        );
      return [
        await run(`"variantId" = ${second}`),
        await run(`"attributeId" = ${other.id}`),
        await run('id = id + 1000000'),
        await run(`"textValue" = 'Two'`),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['42501', '42501', '42501', 'done']);
  });
});

describe('variant_attribute_values: the value fits the type of the characteristic', () => {
  it('takes a text, trimmed and up to 500 signs, and refuses an empty, padded or longer one', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const attribute = await anAttribute(db, 'text');
      await db.as(asAdmin());
      const results = [];
      for (const text of [
        'x'.repeat(500),
        'Matte finish',
        '',
        ' padded',
        'padded ',
        'x'.repeat(501),
      ]) {
        results.push(await putValue(db, await aVariant(db, product), attribute, { text }));
      }
      return results;
    });

    expect(outcomes.map(codeOf)).toEqual(['done', 'done', '23514', '23514', '23514', '23514']);
  });

  it('takes a number within the digits after the point and the bounds, and says how it is wrong', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const attribute = await anAttribute(db, 'number', { decimals: 1, min: 1, max: 100 });
      await db.as(asAdmin());
      const results = [];
      for (const number of [1, 100, 12.5, 12.55, 0.9, 100.1]) {
        results.push(await putValue(db, await aVariant(db, product), attribute, { number }));
      }
      return results;
    });

    expect(outcomes.map(messageOf)).toEqual([
      'done',
      'done',
      'done',
      'ATTRIBUTE_VALUE_TOO_PRECISE',
      'ATTRIBUTE_VALUE_TOO_SMALL',
      'ATTRIBUTE_VALUE_TOO_LARGE',
    ]);
  });

  it('takes a negative number and a number without bounds, and holds the digits of a whole one', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const free = await anAttribute(db, 'number', { decimals: 3 });
      const whole = await anAttribute(db, 'number', { decimals: 0 });
      await db.as(asAdmin());
      return [
        await putValue(db, await aVariant(db, product), free, { number: -2.125 }),
        await putValue(db, await aVariant(db, product), free, { number: 999_999_999_999_999 }),
        await putValue(db, await aVariant(db, product), whole, { number: 7 }),
        await putValue(db, await aVariant(db, product), whole, { number: 7.5 }),
      ];
    });

    expect(outcomes.map(messageOf)).toEqual([
      'done',
      'done',
      'done',
      'ATTRIBUTE_VALUE_TOO_PRECISE',
    ]);
  });

  it('takes yes and no for a yes/no characteristic and a value of its own list for a choice', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const flag = await anAttribute(db, 'boolean');
      const choice = await anAttribute(db, 'option');
      const set1 = await anAttribute(db, 'options');
      const own = await anOption(db, choice);
      const ownOfSet = await anOption(db, set1);
      await db.as(asAdmin());
      return [
        await putValue(db, await aVariant(db, product), flag, { bool: true }),
        await putValue(db, await aVariant(db, product), flag, { bool: false }),
        await putValue(db, await aVariant(db, product), choice, { optionId: own }),
        await putValue(db, await aVariant(db, product), set1, { optionId: ownOfSet }),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('refuses a value in the column another type asks for, and a row with two values or none', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const variantId = await aVariant(db, product);
      const text = await anAttribute(db, 'text');
      const number = await anAttribute(db, 'number');
      const flag = await anAttribute(db, 'boolean');
      const choice = await anAttribute(db, 'option');
      const option = await anOption(db, choice);
      await db.as(asAdmin());
      return [
        await putValue(db, variantId, text, { number: 1 }),
        await putValue(db, variantId, number, { text: '1' }),
        await putValue(db, variantId, flag, { text: 'yes' }),
        await putValue(db, variantId, choice, { bool: true }),
        await putValue(db, variantId, text, { optionId: option }),
        await putValue(db, variantId, text, {}),
        await putValue(db, variantId, text, { text: 'a', number: 1 }),
        await putValue(db, variantId, choice, { optionId: option, bool: true }),
      ];
    });

    expect(outcomes.map(messageOf)).toEqual(Array(8).fill('ATTRIBUTE_VALUE_INVALID'));
    expect(outcomes.map(codeOf)).toEqual(Array(8).fill('23514'));
  });

  it('refuses a value of a list that belongs to another characteristic', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const colour = await anAttribute(db, 'option');
      const size = await anAttribute(db, 'options');
      const black = await anOption(db, colour);
      const large = await anOption(db, size);
      await db.as(asAdmin());
      return [
        await putValue(db, await aVariant(db, product), colour, { optionId: large }),
        await putValue(db, await aVariant(db, product), size, { optionId: black }),
        await putValue(db, await aVariant(db, product), colour, { optionId: black }),
      ];
    });

    expect(outcomes.map(messageOf)).toEqual([
      'ATTRIBUTE_OPTION_NOT_FOUND',
      'ATTRIBUTE_OPTION_NOT_FOUND',
      'done',
    ]);
  });

  it('leaves a characteristic or a value that is not there to the foreign keys', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const variantId = await aVariant(db, product);
      const choice = await anAttribute(db, 'option');
      const text = await anAttribute(db, 'text');
      await db.as(asAdmin());
      return [
        await putValue(db, variantId, { id: 2_000_000_000, type: 'text' }, { text: 'x' }),
        await putValue(db, variantId, choice, { optionId: 2_000_000_000 }),
        await putValue(db, 2_000_000_000, text, { text: 'x' }),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['23503', '23503', '23503']);
  });
});

describe('variant_attribute_values: one row for a value', () => {
  it('holds a text, a number and yes/no once for a variant, and a choice of one value too', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const variantId = await aVariant(db, product);
      const text = await anAttribute(db, 'text');
      const number = await anAttribute(db, 'number');
      const flag = await anAttribute(db, 'boolean');
      const choice = await anAttribute(db, 'option');
      const black = await anOption(db, choice);
      const white = await anOption(db, choice);
      await db.as(asAdmin());
      return [
        await putValue(db, variantId, text, { text: 'a' }),
        await putValue(db, variantId, text, { text: 'b' }),
        await putValue(db, variantId, number, { number: 1 }),
        await putValue(db, variantId, number, { number: 2 }),
        await putValue(db, variantId, flag, { bool: true }),
        await putValue(db, variantId, flag, { bool: false }),
        await putValue(db, variantId, choice, { optionId: black }),
        await putValue(db, variantId, choice, { optionId: white }),
        await putValue(db, variantId, choice, { optionId: black }),
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
      '23505',
      '23505',
    ]);
    expect(messageOf(outcomes[7]!)).toBe('ATTRIBUTE_VALUE_REPEATED');
  });

  it('holds each value of a set once and lets a variant have several', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const first = await aVariant(db, product);
      const second = await aVariant(db, product);
      const set1 = await anAttribute(db, 'options');
      const one = await anOption(db, set1);
      const two = await anOption(db, set1);
      await db.as(asAdmin());
      return [
        await putValue(db, first, set1, { optionId: one }),
        await putValue(db, first, set1, { optionId: two }),
        await putValue(db, first, set1, { optionId: one }),
        await putValue(db, second, set1, { optionId: one }),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', 'done', '23505', 'done']);
  });

  it('lets a change move the value of a choice, but not give a variant two values of it', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const variantId = await aVariant(db, product);
      const choice = await anAttribute(db, 'option');
      const black = await anOption(db, choice);
      const white = await anOption(db, choice);
      await db.as(asAdmin());
      const made = await putValue(db, variantId, choice, { optionId: black });
      return [
        made,
        await db.attempt(
          'update cartlify.variant_attribute_values set "optionId" = $1 where id = $2 returning id',
          white,
          made.ok ? made.rows[0]!.id : 0,
        ),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['done', 'done']);
  });
});

describe('variant_attribute_values: what the rows hold on to', () => {
  it('go with their variant', async () => {
    const left = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const variantId = await aVariant(db, product);
      const attribute = await anAttribute(db, 'text');
      await set(db, variantId, attribute, { text: 'x' });
      const removed = await db.attempt(
        'delete from cartlify.product_variants where id = $1 returning id',
        variantId,
      );
      return {
        removed: changedRows(removed),
        left: await db.rows(
          'select id from cartlify.variant_attribute_values where "variantId" = $1',
          variantId,
        ),
      };
    });

    expect(left).toEqual({ removed: true, left: [] });
  });

  it('keep their characteristic and their value of a list from being deleted', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const variantId = await aVariant(db, product);
      const choice = await anAttribute(db, 'option');
      const option = await anOption(db, choice);
      await set(db, variantId, choice, { optionId: option });
      await db.as(asAdmin());
      return [
        await db.attempt(
          'delete from cartlify.attribute_options where id = $1 returning id',
          option,
        ),
        await db.attempt('delete from cartlify.attributes where id = $1 returning id', choice.id),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['23503', '23503']);
  });

  it('let a characteristic or a value that no variant has be deleted', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      const choice = await anAttribute(db, 'option');
      const option = await anOption(db, choice);
      return [
        await db.attempt(
          'delete from cartlify.attribute_options where id = $1 returning id',
          option,
        ),
        await db.attempt('delete from cartlify.attributes where id = $1 returning id', choice.id),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([true, true]);
  });

  it('lock the type of a characteristic that a variant has a value of, for every role', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const variantId = await aVariant(db, product);
      const held = await anAttribute(db, 'text');
      const free = await anAttribute(db, 'text');
      await set(db, variantId, held, { text: 'x' });
      await db.as(asAdmin());
      return [
        await db.attempt(
          `update cartlify.attributes set type = 'boolean' where id = $1 returning id`,
          held.id,
        ),
        // a change that is no change of the type is no business of the lock
        await db.attempt(
          `update cartlify.attributes set unit = 'mm' where id = $1 returning id`,
          held.id,
        ),
        await db.attempt(
          `update cartlify.attributes set type = 'boolean' where id = $1 returning id`,
          free.id,
        ),
      ];
    });

    expect(outcomes.map(codeOf)).toEqual(['23514', 'done', 'done']);
    expect(messageOf(outcomes[0]!)).toBe('ATTRIBUTE_TYPE_LOCKED');
  });
});

describe('cartlify.variant_names', () => {
  it.each([
    ['a guest', asGuest],
    ['a user', asUser],
    ['an admin', asAdmin],
  ])('is read by %s and is the plain name of a product with one variant', async (_who, actor) => {
    const { names, expected } = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const variantId = await aVariant(db, product);
      const attribute = await anAttribute(db, 'text');
      await set(db, variantId, attribute, { text: 'Matte' });
      await db.as(actor());
      return {
        names: await namesOf(db, [variantId]),
        expected: { id: variantId, name: product.name },
      };
    });

    expect(names.get(expected.id)).toEqual({
      variant_id: expected.id,
      name: expected.name,
      values: [],
    });
  });

  it('names a variant with the values that differ, and leaves out a value all the variants share', async () => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const black = await aVariant(db, product);
      const white = await aVariant(db, product);
      const colour = await anAttribute(db, 'option', { name: 'Colour' });
      const finish = await anAttribute(db, 'text', { name: 'Finish' });
      const blackId = await anOption(db, colour, 'black');
      const whiteId = await anOption(db, colour, 'white');
      await set(db, black, colour, { optionId: blackId });
      await set(db, white, colour, { optionId: whiteId });
      await set(db, black, finish, { text: 'Matte' });
      await set(db, white, finish, { text: 'Matte' });
      const names = await namesOf(db, [black, white]);
      return {
        black: names.get(black),
        white: names.get(white),
        base: product.name,
        colourId: colour.id,
      };
    });

    expect(found.black).toMatchObject({
      name: `${found.base} ${DASH} black`,
      values: [{ attributeId: found.colourId, name: 'Colour', value: 'black' }],
    });
    expect(found.white!.name).toBe(`${found.base} ${DASH} white`);
  });

  it('puts the main characteristics first, then follows the group and the place of the directory', async () => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const first = await aVariant(db, product);
      const second = await aVariant(db, product);
      const early = await aGroup(db);
      const late = await aGroup(db);
      const lateText = await anAttribute(db, 'text', { groupId: late, position: 1 });
      const earlySecond = await anAttribute(db, 'text', { groupId: early, position: 2 });
      const earlyFirst = await anAttribute(db, 'text', { groupId: early, position: 1 });
      const mainOne = await anAttribute(db, 'number', {
        groupId: late,
        position: 2,
        isMain: true,
        unit: 'GB',
      });
      for (const [variantId, tag, memory] of [
        [first, 'a', 128],
        [second, 'b', 256],
      ] as const) {
        await set(db, variantId, lateText, { text: `late-${tag}` });
        await set(db, variantId, earlySecond, { text: `early2-${tag}` });
        await set(db, variantId, earlyFirst, { text: `early1-${tag}` });
        await set(db, variantId, mainOne, { number: memory });
      }
      return (await namesOf(db, [first])).get(first)!;
    });

    expect((found.values as { value: string }[]).map((value) => value.value)).toEqual([
      '128 GB',
      'early1-a',
      'early2-a',
      'late-a',
    ]);
    expect(found.name.split(` ${DASH} `)[1]).toBe('128 GB, early1-a, early2-a, late-a');
  });

  it('writes a number without its trailing zeros and with its unit, a yes/no with the name', async () => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const first = await aVariant(db, product);
      const second = await aVariant(db, product);
      const weight = await anAttribute(db, 'number', { name: 'Weight', unit: 'kg', decimals: 3 });
      const plain = await anAttribute(db, 'number', { name: 'Count', decimals: 3 });
      const flag = await anAttribute(db, 'boolean', { name: 'Waterproof' });
      await set(db, first, weight, { number: '1.500' });
      await set(db, second, weight, { number: 2 });
      await set(db, first, plain, { number: '100' });
      await set(db, second, plain, { number: '0.250' });
      await set(db, first, flag, { bool: true });
      await set(db, second, flag, { bool: false });
      const names = await namesOf(db, [first, second]);
      return {
        first: names.get(first)!,
        second: names.get(second)!,
        plainId: plain.id,
        flagId: flag.id,
      };
    });

    expect(found.first.name.split(` ${DASH} `)[1]).toBe('1.5 kg, 100, Waterproof: yes');
    expect(found.second.name.split(` ${DASH} `)[1]).toBe('2 kg, 0.25, Waterproof: no');
    expect(found.first.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Waterproof', value: 'yes' }),
        expect.objectContaining({ attributeId: found.plainId, value: '100' }),
      ]),
    );
  });

  it('writes the values of a set in the order of the directory, joined with a comma', async () => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const first = await aVariant(db, product);
      const second = await aVariant(db, product);
      const set1 = await anAttribute(db, 'options', { name: 'Features' });
      const gps = await anOption(db, set1, 'GPS', 30);
      const nfc = await anOption(db, set1, 'NFC', 10);
      const lte = await anOption(db, set1, 'LTE', 20);
      await set(db, first, set1, { optionId: gps });
      await set(db, first, set1, { optionId: nfc });
      await set(db, second, set1, { optionId: lte });
      return (await namesOf(db, [first, second])).get(first)!;
    });

    expect(found.name.split(` ${DASH} `)[1]).toBe('NFC, GPS');
  });

  it('counts two sets with the same values in another order as the same value', async () => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const first = await aVariant(db, product);
      const second = await aVariant(db, product);
      const set1 = await anAttribute(db, 'options');
      const one = await anOption(db, set1);
      const two = await anOption(db, set1);
      await set(db, first, set1, { optionId: one });
      await set(db, first, set1, { optionId: two });
      await set(db, second, set1, { optionId: two });
      await set(db, second, set1, { optionId: one });
      return (await namesOf(db, [first, second])).get(first)!.name;
    });

    expect(found).not.toContain(DASH);
  });

  it('counts a variant without a value as another value, and gives it no label', async () => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const first = await aVariant(db, product);
      const second = await aVariant(db, product);
      const memory = await anAttribute(db, 'number', { name: 'Memory', unit: 'GB' });
      await set(db, first, memory, { number: 128 });
      const names = await namesOf(db, [first, second]);
      return { first: names.get(first)!.name, second: names.get(second)!.name, base: product.name };
    });

    expect(found.first).toBe(`${found.base} ${DASH} 128 GB`);
    expect(found.second).toBe(found.base);
  });

  it('compares the visible variants only, and a hidden variant with the live ones', async () => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const first = await aVariant(db, product);
      const second = await aVariant(db, product);
      const withoutPicture = await aVariant(db, product, { visible: false });
      const deleted = await aVariant(db, product, { deleted: true });
      const colour = await anAttribute(db, 'option', { name: 'Colour' });
      const memory = await anAttribute(db, 'text', { name: 'Memory' });
      const black = await anOption(db, colour, 'black');
      const red = await anOption(db, colour, 'red');
      // the two visible variants are alike in the colour; the others differ from them
      for (const variantId of [first, second])
        await set(db, variantId, colour, { optionId: black });
      await set(db, withoutPicture, colour, { optionId: red });
      await set(db, deleted, colour, { optionId: red });
      await set(db, first, memory, { text: '128' });
      await set(db, second, memory, { text: '256' });
      await set(db, withoutPicture, memory, { text: '128' });
      await set(db, deleted, memory, { text: '128' });
      const names = await namesOf(db, [first, second, withoutPicture, deleted]);
      const read = (id: number) => names.get(id)!.name.split(` ${DASH} `)[1] ?? '';
      return {
        first: read(first),
        second: read(second),
        withoutPicture: read(withoutPicture),
        deleted: read(deleted),
      };
    });

    // among the visible ones only the memory differs
    expect(found.first).toBe('128');
    expect(found.second).toBe('256');
    // a variant without a picture is compared with the live ones (the two visible and itself)
    expect(found.withoutPicture).toBe('red, 128');
    // a deleted one with the live ones too (it is not one of them) and itself
    expect(found.deleted).toBe('red, 128');
  });

  it('gives a name to a variant that is the only one visible, and to one that is the only one live', async () => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const only = await aVariant(db, product);
      const hidden = await aVariant(db, product, { visible: false });
      const memory = await anAttribute(db, 'text', { name: 'Memory' });
      await set(db, only, memory, { text: '128' });
      await set(db, hidden, memory, { text: '256' });
      const names = await namesOf(db, [only, hidden]);
      return { only: names.get(only)!.name, hidden: names.get(hidden)!.name, base: product.name };
    });

    expect(found.only).toBe(found.base);
    expect(found.hidden).toBe(`${found.base} ${DASH} 256`);
  });

  it('reads the names of variants of many products in one call, once for a variant named twice', async () => {
    const found = await inRolledBackTx(async (db) => {
      const one = await aProduct(db);
      const two = await aProduct(db);
      const a1 = await aVariant(db, one);
      const a2 = await aVariant(db, one);
      const b1 = await aVariant(db, two);
      const colour = await anAttribute(db, 'text', { name: 'Colour' });
      await set(db, a1, colour, { text: 'black' });
      await set(db, a2, colour, { text: 'white' });
      await set(db, b1, colour, { text: 'black' });
      const rows = await db.rows<{ variant_id: number }>(
        'select variant_id from cartlify.variant_names($1::int[])',
        [a1, a2, b1, a1, 2_000_000_000],
      );
      const names = await namesOf(db, [a1, a2, b1]);
      return {
        count: rows.length,
        a1: names.get(a1)!.name,
        b1: names.get(b1)!.name,
        oneName: one.name,
        twoName: two.name,
      };
    });

    expect(found.count).toBe(3);
    expect(found.a1).toBe(`${found.oneName} ${DASH} black`);
    expect(found.b1).toBe(found.twoName);
  });

  it('follows a rename of a value, of a characteristic and of a unit at once', async () => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const first = await aVariant(db, product);
      const second = await aVariant(db, product);
      const colour = await anAttribute(db, 'option', { name: 'Colour' });
      const memory = await anAttribute(db, 'number', { name: 'Memory', unit: 'GB' });
      const black = await anOption(db, colour, 'black');
      const white = await anOption(db, colour, 'white');
      await set(db, first, colour, { optionId: black });
      await set(db, second, colour, { optionId: white });
      await set(db, first, memory, { number: 128 });
      await set(db, second, memory, { number: 256 });
      const before = await nameOf(db, first);
      await db.rows(
        `update cartlify.attribute_options set name = 'graphite' where id = $1 returning id`,
        black,
      );
      await db.rows(
        `update cartlify.attributes set unit = 'TB' where id = $1 returning id`,
        memory.id,
      );
      return { before, after: await nameOf(db, first), base: product.name };
    });

    expect(found.before).toBe(`${found.base} ${DASH} black, 128 GB`);
    expect(found.after).toBe(`${found.base} ${DASH} graphite, 128 TB`);
  });

  it('tells which characteristics are main at once', async () => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const first = await aVariant(db, product);
      const second = await aVariant(db, product);
      const early = await anAttribute(db, 'text', { name: 'Early' });
      const colour = await anAttribute(db, 'option', { name: 'Colour' });
      const black = await anOption(db, colour, 'black');
      const white = await anOption(db, colour, 'white');
      await set(db, first, early, { text: 'a' });
      await set(db, second, early, { text: 'b' });
      await set(db, first, colour, { optionId: black });
      await set(db, second, colour, { optionId: white });
      const before = await nameOf(db, first);
      await db.rows(
        `update cartlify.attributes set "isMain" = true where id = $1 returning id`,
        colour.id,
      );
      return { before, after: await nameOf(db, first), base: product.name };
    });

    // both are alike in rank, so the order of the directory decides (the groups here come in order of making)
    expect(found.before).toBe(`${found.base} ${DASH} a, black`);
    expect(found.after).toBe(`${found.base} ${DASH} black, a`);
  });

  it('is the name an order item keeps: variant_display_name gives the same one', async () => {
    const found = await inRolledBackTx(async (db) => {
      const product = await aProduct(db);
      const first = await aVariant(db, product);
      const second = await aVariant(db, product);
      const colour = await anAttribute(db, 'text', { name: 'Colour' });
      await set(db, first, colour, { text: 'black' });
      await set(db, second, colour, { text: 'white' });
      const [row] = await db.rows<{ name: string }>(
        'select cartlify.variant_display_name($1::int) as name',
        first,
      );
      return { display: row!.name, names: await nameOf(db, first) };
    });

    expect(found.display).toBe(found.names);
    expect(found.display).toContain(DASH);
  });

  it('gives null for a variant that is not there', async () => {
    const found = await inRolledBackTx(async (db) => {
      const [row] = await db.rows<{ name: string | null }>(
        'select cartlify.variant_display_name($1::int) as name',
        2_000_000_000,
      );
      return row!.name;
    });

    expect(found).toBeNull();
  });
});

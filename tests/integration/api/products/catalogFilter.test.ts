import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import {
  answerOf,
  choose,
  createChoice,
  createProductWith,
  numberOf,
  type TestChoice,
  type VariantSpec,
} from '../../../helpers/characteristics.js';
import { MAX_ID } from '@schemas/idPathParam.js';
import {
  closeSessions,
  createAttribute,
  createCategory,
  createUser,
  deleteProductFromCatalog,
  type TestAttribute,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { markVariantDeleted, stripVariantImages } from '../../../helpers/variants.js';

// The filter of the catalog by characteristics: `f=<attributeId>:<value>`, one entry for a
// characteristic, the parameter repeats. A choice from a list (a colour too) is the ids of its
// values, `f=12:45,46`; a number is a range with both ends included, `f=15:128..512` (`128..` and
// `..512` leave an end open); yes/no is `yes` or `no`. The values of one characteristic are OR,
// different characteristics are AND. A variant without a value of a characteristic fits no value of
// it, a variant a buyer does not see is never found. A filter makes the rows variants (the groups of
// the main characteristics, catalogGroups.test.ts)

let app: FastifyInstance;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

let colour: TestChoice;
let features: TestChoice;
let size: TestChoice;
// a main characteristic with a value of its own for every variant of the shelf: no two variants
// of the shelf merge, so a row is one variant
let edition: TestChoice;
let memory: TestAttribute;
let diagonal: TestAttribute;
let waterproof: TestAttribute;
let note: TestAttribute;

// the shelf: a category with the phones of the tests that only read
let shelf: string;
let phone: { name: string; variantIds: number[] };
let other: { name: string; variantIds: number[] };

// the variants get the editions e1, e2, ... from `first`
const editions = (first: number, specs: VariantSpec[]): VariantSpec[] =>
  specs.map((spec, index) => ({
    ...spec,
    values: [...(spec.values ?? []), choose(edition, `e${first + index + 1}`)],
  }));

beforeAll(async () => {
  app = await startApp();
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);

  colour = await createChoice(['black', 'white', 'red']);
  features = await createChoice(['wifi', 'bluetooth', 'nfc'], { type: 'options' });
  size = await createChoice(['S', 'M', 'L']);
  edition = await createChoice(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'], { isMain: true });
  memory = await createAttribute({ type: 'number', unit: 'GB' });
  diagonal = await createAttribute({ type: 'number', decimals: 1, unit: 'in' });
  waterproof = await createAttribute({ type: 'boolean' });
  note = await createAttribute({ type: 'text' });

  shelf = String((await createCategory()).id);
  const category = Number(shelf);

  // names of words that are far from each other: a search for one finds not the other
  const name = 'Aurora handset';
  const a = await createProductWith(
    category,
    editions(0, [
      // a1
      {
        price: 500,
        values: [
          choose(colour, 'black'),
          numberOf(memory, 64),
          numberOf(diagonal, 6.1),
          answerOf(waterproof, true),
          choose(features, 'wifi'),
        ],
      },
      // a2
      {
        price: 600,
        values: [
          choose(colour, 'black'),
          numberOf(memory, 128),
          numberOf(diagonal, 6.5),
          answerOf(waterproof, false),
          choose(features, 'wifi'),
          choose(features, 'nfc'),
        ],
      },
      // a3
      {
        price: 700,
        values: [
          choose(colour, 'white'),
          numberOf(memory, 256),
          numberOf(diagonal, 6.7),
          answerOf(waterproof, true),
          choose(features, 'bluetooth'),
        ],
      },
      // a4: no yes/no, no list of features
      {
        price: 800,
        values: [choose(colour, 'red'), numberOf(memory, 512), numberOf(diagonal, 6.8)],
      },
      // a5: no value at all
      { price: 150 },
      // a6: black, taken out of sale
      { price: 160, values: [choose(colour, 'black'), numberOf(memory, 128)] },
      // a7: black, shows no picture
      { price: 1000, values: [choose(colour, 'black'), numberOf(memory, 128)] },
    ]),
    { name },
  );
  products.push(a.product);
  await markVariantDeleted(a.variantIds[5]!);
  await stripVariantImages(a.variantIds[6]!);
  phone = { name, variantIds: a.variantIds };

  const otherName = 'Zephyr notebook';
  const b = await createProductWith(
    category,
    editions(7, [
      // b1
      {
        price: 300,
        values: [
          choose(colour, 'white'),
          numberOf(memory, 128),
          numberOf(diagonal, 5),
          answerOf(waterproof, false),
          choose(features, 'bluetooth'),
          choose(features, 'nfc'),
        ],
      },
    ]),
    { name: otherName },
  );
  products.push(b.product);
  other = { name: otherName, variantIds: b.variantIds };
});

afterAll(async () => {
  try {
    for (const product of products) await deleteProductFromCatalog(product.id);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Row = {
  product: { id: number };
  variant: { id: number; visible?: boolean };
  minPrice?: number;
  maxPrice?: number;
  stock: number;
};

type Query = Record<string, string | string[]>;

const urlOf = (query: Query) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : [value]) params.append(key, one);
  }
  return `/api/products?${params}`;
};

const list = (query: Query, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: urlOf(query),
    headers: actor ? { cookie: accessCookie(actor) } : {},
  });

const rowsOf = (res: LightMyRequestResponse) => {
  expect(res.statusCode).toBe(200);
  return res.json().items as Row[];
};

const idsOf = (res: LightMyRequestResponse) => rowsOf(res).map((row) => row.variant.id);

// the shelf by a filter, the cheapest first
const found = (f: string | string[], extra: Query = {}, actor?: TestUser) =>
  list({ categoryIds: shelf, sort: 'price', order: 'asc', f, ...extra }, actor);

// the variants of the shelf by their place in the fixture: a(1) .. a(7) of the phone, b1 of the other
const a = (n: number) => phone.variantIds[n - 1]!;
const b1 = () => other.variantIds[0]!;

const option = (choice: TestChoice, ...names: string[]) =>
  `${choice.attribute.id}:${names.map((name) => choice.option[name]).join(',')}`;

describe('what a filter finds', () => {
  it('finds the variants that have any of the values asked of a characteristic', async () => {
    const white = await found(option(colour, 'white'));
    const both = await found(option(colour, 'black', 'white'));

    expect(idsOf(white)).toEqual([b1(), a(3)]);
    // OR inside a characteristic; the variant taken out of sale and the one without a picture are not found
    expect(idsOf(both)).toEqual([b1(), a(1), a(2), a(3)]);
    expect(both.json().total).toBe(4);
  });

  it('finds the variants that fit every characteristic asked', async () => {
    const res = await found([option(colour, 'black'), `${memory.id}:100..`]);

    expect(idsOf(res)).toEqual([a(2)]);
  });

  it('finds a variant that has any of the values asked of a set, once', async () => {
    const res = await found(option(features, 'nfc', 'bluetooth'));

    // b1 has both values and is one row
    expect(idsOf(res)).toEqual([b1(), a(2), a(3)]);
  });

  it('holds the ends of a number in the range', async () => {
    expect(idsOf(await found(`${memory.id}:128..256`))).toEqual([b1(), a(2), a(3)]);
    expect(idsOf(await found(`${memory.id}:128..128`))).toEqual([b1(), a(2)]);
  });

  it('leaves an end of a range open', async () => {
    expect(idsOf(await found(`${memory.id}:256..`))).toEqual([a(3), a(4)]);
    expect(idsOf(await found(`${memory.id}:..64`))).toEqual([a(1)]);
  });

  it('compares decimals as numbers', async () => {
    expect(idsOf(await found(`${diagonal.id}:6.1..6.7`))).toEqual([a(1), a(2), a(3)]);
    expect(idsOf(await found(`${diagonal.id}:6.1..6.1`))).toEqual([a(1)]);
    expect(idsOf(await found(`${diagonal.id}:..6.1`))).toEqual([b1(), a(1)]);
    // a bound with more digits than the characteristic keeps
    expect(idsOf(await found(`${diagonal.id}:6.05..6.15`))).toEqual([a(1)]);
  });

  it('finds the variants with the answer asked of a yes/no characteristic', async () => {
    expect(idsOf(await found(`${waterproof.id}:yes`))).toEqual([a(1), a(3)]);
    expect(idsOf(await found(`${waterproof.id}:no`))).toEqual([b1(), a(2)]);
  });

  it('finds no variant that has no value of the characteristic, whatever it asks', async () => {
    // the red phone has no answer, the variant with no value has nothing
    const answered = [
      ...idsOf(await found(`${waterproof.id}:yes`)),
      ...idsOf(await found(`${waterproof.id}:no`)),
    ];
    const coloured = idsOf(await found(option(colour, 'black', 'white', 'red')));
    const sized = idsOf(await found(`${memory.id}:0..`));

    expect(answered).not.toContain(a(4));
    expect(answered).not.toContain(a(5));
    expect(coloured).not.toContain(a(5));
    expect(sized).not.toContain(a(5));
    // and it is there when nothing is asked
    expect(idsOf(await list({ categoryIds: shelf, sort: 'price', order: 'asc' }))).toContain(a(5));
  });

  it('does not find the variants a buyer does not see, and gives an admin the ones that are alive', async () => {
    const black = option(colour, 'black');

    const buyer = await found(black);
    const asAdmin = await found(black, {}, admin);

    expect(idsOf(buyer)).toEqual([a(1), a(2)]);
    // the variant without a picture is there for an admin, the one taken out of sale is not
    expect(idsOf(asAdmin)).toEqual([a(1), a(2), a(7)]);
    expect(rowsOf(asAdmin)[2]!.variant).toMatchObject({ id: a(7), visible: false });
  });

  it('finds by a characteristic that is out of the filters of the panel too', async () => {
    const hidden = await createChoice(['x', 'y'], { inFilters: false });
    const category = (await createCategory()).id;
    const made = await createProductWith(category, [
      { price: 10, values: [choose(hidden, 'x'), choose(edition, 'e1')] },
      { price: 11, values: [choose(hidden, 'y'), choose(edition, 'e2')] },
    ]);
    products.push(made.product);

    const res = await list({ categoryIds: String(category), f: option(hidden, 'y') });

    expect(idsOf(res)).toEqual([made.variantIds[1]]);
  });

  it('finds by a characteristic in the whole catalog when no category is asked', async () => {
    const res = await list({ f: option(colour, 'red'), sort: 'price', order: 'asc' });

    expect(idsOf(res)).toContain(a(4));
  });
});

describe('the rows of a list with a filter', () => {
  it('are groups: the rows have the range of the prices of the variants that fit', async () => {
    // the tint is main here: the dark variants of a T-shirt are one row
    const tint = await createChoice(['dark', 'light'], { isMain: true });
    const category = (await createCategory()).id;
    const made = await createProductWith(category, [
      { price: 10, values: [choose(tint, 'dark'), choose(size, 'S')] },
      { price: 14, values: [choose(tint, 'dark'), choose(size, 'M')] },
      { price: 12, values: [choose(tint, 'light'), choose(size, 'M')] },
    ]);
    products.push(made.product);

    const dark = await list({ categoryIds: String(category), f: option(tint, 'dark') });
    const medium = await list({
      categoryIds: String(category),
      f: [option(size, 'M')],
      sort: 'price',
      order: 'asc',
    });

    expect(rowsOf(dark)).toHaveLength(1);
    expect(rowsOf(dark)[0]).toMatchObject({
      variant: { id: made.variantIds[0] },
      minPrice: 10,
      maxPrice: 14,
      stock: 10,
    });
    // the filter takes the medium sizes: dark and light, each of one variant
    expect(idsOf(medium)).toEqual([made.variantIds[2], made.variantIds[1]]);
    expect(rowsOf(medium)[1]).toMatchObject({ minPrice: 14, maxPrice: 14, stock: 5 });
    expect(medium.json().total).toBe(2);
  });

  it('leave the list of products when a filter is there, with the units of the variants that fit', async () => {
    const plain = await list({ categoryIds: shelf });
    const filtered = await list({ categoryIds: shelf, f: option(colour, 'white') });

    expect(rowsOf(plain).map((row) => row.product.id)).toHaveLength(2);
    expect(plain.json().total).toBe(2);
    // two rows, both white variants, every row a variant with its range of prices
    expect(rowsOf(filtered)).toHaveLength(2);
    for (const row of rowsOf(filtered)) {
      expect(row.minPrice).toBeDefined();
      expect(row.minPrice).toBe(row.maxPrice);
      expect(row.stock).toBe(5);
    }
  });

  it('go with the filter of the price and the sort', async () => {
    const both = option(colour, 'black', 'white');

    const asc = await found(both, { minPrice: '450', maxPrice: '650' });
    const desc = await found(both, { minPrice: '450', order: 'desc' });

    expect(idsOf(asc)).toEqual([a(1), a(2)]);
    expect(idsOf(desc)).toEqual([a(3), a(2), a(1)]);
  });

  it('go with a search', async () => {
    const byName = await found(option(colour, 'white'), { search: phone.name });
    const byOther = await found(option(colour, 'white'), { search: other.name });
    const nothing = await found(option(colour, 'red'), { search: other.name });

    expect(idsOf(byName)).toEqual([a(3)]);
    expect(idsOf(byOther)).toEqual([b1()]);
    expect(rowsOf(nothing)).toEqual([]);
    expect(nothing.json().total).toBe(0);
  });

  it('go with the filter of the stock', async () => {
    const res = await found(option(colour, 'black'), { inStock: 'false' });

    expect(rowsOf(res)).toEqual([]);
    expect(idsOf(await found(option(colour, 'black'), { inStock: 'true' }))).toEqual([a(1), a(2)]);
  });

  it('walk page by page, none twice or lost', async () => {
    const f = option(colour, 'black', 'white');
    const ids: number[] = [];
    const totals = new Set<number>();
    let cursor: string | undefined;
    let pages = 0;

    do {
      const res = await found(f, { limit: '1', ...(cursor ? { cursor } : {}) });
      ids.push(...idsOf(res));
      totals.add(res.json().total);
      cursor = res.json().nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);

    expect(ids).toEqual([b1(), a(1), a(2), a(3)]);
    expect(pages).toBe(4);
    expect(totals).toEqual(new Set([4]));
  });

  it('are the same for an admin, with the full variant', async () => {
    const res = await found(option(colour, 'white'), {}, admin);

    expect(idsOf(res)).toEqual([b1(), a(3)]);
    expect(rowsOf(res)[0]!.variant).toMatchObject({ totalStock: 5, visible: true });
  });

  it('are the variants on their own for an admin who asks for it', async () => {
    const res = await found(option(colour, 'black'), { group: 'false' }, admin);

    expect(idsOf(res)).toEqual([a(1), a(2), a(7)]);
    for (const row of rowsOf(res)) expect(row).not.toHaveProperty('minPrice');
  });
});

describe('the parameter in the url', () => {
  it('is read as it is written, with no sign encoded', async () => {
    const f = `${colour.attribute.id}:${colour.option.black},${colour.option.white}`;

    const res = await app.inject({
      method: 'GET',
      url: `/api/products?categoryIds=${shelf}&sort=price&order=asc&f=${f}&f=${memory.id}:100..256`,
    });

    expect(idsOf(res)).toEqual([b1(), a(2), a(3)]);
  });

  it('is read once or many times alike', async () => {
    const one = await list({ categoryIds: shelf, f: `${memory.id}:..64` });
    const many = await list({
      categoryIds: shelf,
      f: [`${memory.id}:..64`, `${waterproof.id}:yes`],
    });

    expect(idsOf(one)).toEqual([a(1)]);
    expect(idsOf(many)).toEqual([a(1)]);
  });

  it('ignores the spaces around the parts', async () => {
    const res = await found(` ${memory.id} : 128 .. 256 `);

    expect(idsOf(res)).toEqual([b1(), a(2), a(3)]);
  });

  // the suggestions are names of products; fastify strips a parameter the schema does not name
  it('is no part of the suggestions of the search: they are the same with it', async () => {
    const url = '/api/products/suggestions?q=aurora';

    const plain = await app.inject({ method: 'GET', url });
    const withFilter = await app.inject({ method: 'GET', url: `${url}&f=${memory.id}:..64` });

    expect(plain.statusCode).toBe(200);
    expect(withFilter.statusCode).toBe(200);
    expect(withFilter.json()).toEqual(plain.json());
    expect(plain.json().items.map((item: { name: string }) => item.name)).toContain(phone.name);
  });
});

describe('what a filter refuses', () => {
  const refused = async (f: string | string[], actor?: TestUser) => {
    const res = await found(f, {}, actor);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'FILTER_INVALID' });

    return res.json().details as Record<string, unknown>;
  };

  it.each([
    ['an empty parameter', ''],
    ['a text that is no entry', 'black'],
    ['an entry without a characteristic', ':5'],
    ['an entry without a value', '5:'],
  ])('refuses %s', async (_case, f) => {
    expect(await refused(f)).toMatchObject({
      reason: expect.stringMatching(/^(ENTRY|VALUE)_INVALID$/),
    });
  });

  it('names the entry that is wrong among the ones that are good', async () => {
    const details = await refused([`${memory.id}:1..2`, `${waterproof.id}:maybe`]);

    expect(details).toEqual({
      reason: 'VALUE_INVALID',
      entry: `${waterproof.id}:maybe`,
      index: 1,
      attributeId: waterproof.id,
    });
  });

  it('refuses a characteristic that is not there', async () => {
    const details = await refused(`${MAX_ID}:1`);

    expect(details).toEqual({
      reason: 'ATTRIBUTE_NOT_FOUND',
      entry: `${MAX_ID}:1`,
      index: 0,
      attributeId: MAX_ID,
    });
  });

  it('refuses a text, which cannot be filtered', async () => {
    const details = await refused(`${note.id}:1`);

    expect(details).toEqual({
      reason: 'ATTRIBUTE_NOT_FILTERABLE',
      entry: `${note.id}:1`,
      index: 0,
      attributeId: note.id,
      type: 'text',
    });
  });

  it('refuses a value that is not a value of the characteristic', async () => {
    const wrong = [colour.option.black!, features.option.nfc!];
    const details = await refused(`${colour.attribute.id}:${wrong.join(',')}`);

    expect(details).toMatchObject({
      reason: 'OPTION_NOT_FOUND',
      attributeId: colour.attribute.id,
      optionIds: [features.option.nfc],
    });
  });

  it('refuses a value that is the id of nothing', async () => {
    const details = await refused(`${colour.attribute.id}:${MAX_ID}`);

    expect(details).toMatchObject({ reason: 'OPTION_NOT_FOUND', optionIds: [MAX_ID] });
  });

  it.each([
    ['a range for a choice', () => `${colour.attribute.id}:1..2`, 'option'],
    ['yes for a set', () => `${features.attribute.id}:yes`, 'options'],
    ['ids for a number', () => `${memory.id}:5`, 'number'],
    ['yes for a number', () => `${memory.id}:yes`, 'number'],
    ['ids for yes/no', () => `${waterproof.id}:5`, 'boolean'],
    ['a range for yes/no', () => `${waterproof.id}:1..2`, 'boolean'],
  ])('refuses %s', async (_case, entry, type) => {
    const details = await refused(entry());

    expect(details).toMatchObject({ reason: 'VALUE_FORM_MISMATCH', type, index: 0 });
    expect(details).toHaveProperty('expected');
  });

  it('refuses a characteristic twice', async () => {
    const details = await refused([`${memory.id}:1..2`, `${memory.id}:5..6`]);

    expect(details).toMatchObject({
      reason: 'ATTRIBUTE_REPEATED',
      index: 1,
      attributeId: memory.id,
    });
  });

  it('refuses a range that ends before it starts', async () => {
    expect(await refused(`${memory.id}:256..128`)).toMatchObject({
      reason: 'RANGE_ORDER',
      attributeId: memory.id,
    });
  });

  it('refuses more entries than the limit lets', async () => {
    const entries = Array.from({ length: 21 }, (_, index) => `${index + 1}:yes`);

    expect(await refused(entries)).toEqual({ reason: 'TOO_MANY_ENTRIES', max: 20, have: 21 });
  });

  it('refuses the same for an admin', async () => {
    expect(await refused(`${note.id}:1`, admin)).toMatchObject({
      reason: 'ATTRIBUTE_NOT_FILTERABLE',
    });
  });

  it('tells a filter that is wrong before the cursor that is wrong', async () => {
    const res = await found(`${note.id}:1`, { cursor: 'abc' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'FILTER_INVALID' });
  });
});

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  answerOf,
  choose,
  createChoice,
  createProductWith,
  numberOf,
  type TestChoice,
  type VariantSpec,
} from '../../../helpers/characteristics.js';
import {
  closeSessions,
  createAttribute,
  createCategory,
  createUser,
  deleteProductFromCatalog,
  putOnSale,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  addGalleryImage,
  markVariantDeleted,
  stripVariantImages,
} from '../../../helpers/variants.js';

// The rows of the catalog list that is about a variant (a price in the sort or in the filter, the
// sale, the filter by characteristics) are GROUPS: the variants of ONE product that have the same
// value of every MAIN characteristic become one row, and only the variants that fit the query take
// part. The row has the lowest and the highest price of the group, the free units of its variants
// and the first variant of the group by its place (its picture too). A variant without a value of a
// main characteristic is a value of its own ("none"); a product with no main characteristic is one
// group. A price sort goes by the lowest price of the group going up and by the highest going down.
// The pages never repeat or skip a group, `total` counts the groups. Every test works in a category
// of its own

let app: FastifyInstance;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

let colour: TestChoice;
let size: TestChoice;
let region: TestChoice;
let memory: Awaited<ReturnType<typeof createAttribute>>;

beforeAll(async () => {
  app = await startApp();
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);

  // the colour and the memory of a phone are main, the size of a T-shirt and the region are not
  colour = await createChoice(['black', 'white', 'red'], { isMain: true });
  size = await createChoice(['S', 'M', 'L']);
  region = await createChoice(['EU', 'US']);
  memory = await createAttribute({ type: 'number', isMain: true, unit: 'GB' });
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
  product: { id: number; name: string };
  variant: Record<string, unknown> & { id: number; price: number; stock: number; image?: object };
  minPrice?: number;
  maxPrice?: number;
  stock: number;
};

async function makeProduct(categoryId: number, specs: VariantSpec[]) {
  const made = await createProductWith(categoryId, specs);
  products.push(made.product);
  return made;
}

const list = (query: Record<string, string>, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: `/api/products?${new URLSearchParams(query)}`,
    headers: actor ? { cookie: accessCookie(actor) } : {},
  });

const rowsOf = (res: LightMyRequestResponse) => {
  expect(res.statusCode).toBe(200);
  return res.json().items as Row[];
};

const variantIdsOf = (res: LightMyRequestResponse) => rowsOf(res).map((row) => row.variant.id);

// every page of a list by the cursor, `size` rows a page: the ids of the variants of the rows, the
// number of the pages and the totals the pages gave
async function walk(query: Record<string, string>, size: number, actor?: TestUser) {
  const ids: number[] = [];
  const totals = new Set<number>();
  let pages = 0;
  let cursor: string | undefined;
  do {
    const res = await list({ ...query, limit: String(size), ...(cursor ? { cursor } : {}) }, actor);
    ids.push(...variantIdsOf(res));
    totals.add(res.json().total);
    cursor = res.json().nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < 50);

  return { ids, pages, totals };
}

const DAY = 86_400_000;

describe('the groups of a list', () => {
  it('gives a T-shirt a row for each colour, whatever the sizes', async () => {
    const category = (await createCategory()).id;
    // the colour is main, the size is not: black and white, two sizes each
    const { product, variantIds } = await makeProduct(category, [
      { price: 20, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 25, values: [choose(colour, 'black'), choose(size, 'M')] },
      { price: 22, values: [choose(colour, 'white'), choose(size, 'S')] },
      { price: 30, values: [choose(colour, 'white'), choose(size, 'M')] },
    ]);

    const asc = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });
    const desc = await list({ categoryIds: String(category), sort: 'price', order: 'desc' });

    const [black, white] = rowsOf(asc);
    expect(rowsOf(asc)).toHaveLength(2);
    // the first variant of a group by its place stands for it
    expect(black).toMatchObject({
      product: { id: product.id },
      variant: { id: variantIds[0] },
      minPrice: 20,
      maxPrice: 25,
      stock: 10,
    });
    expect(white).toMatchObject({ variant: { id: variantIds[2] }, minPrice: 22, maxPrice: 30 });
    expect(asc.json().total).toBe(2);
    // going up a group stands at its lowest price (black 20, white 22), going down at its highest
    // (black 25, white 30)
    expect(variantIdsOf(asc)).toEqual([variantIds[0], variantIds[2]]);
    expect(variantIdsOf(desc)).toEqual([variantIds[2], variantIds[0]]);
    expect(desc.json().total).toBe(2);
  });

  it('gives a phone a row for each memory and colour, the region telling no row', async () => {
    const category = (await createCategory()).id;
    const { variantIds } = await makeProduct(category, [
      {
        price: 500,
        values: [numberOf(memory, 128), choose(colour, 'black'), choose(region, 'EU')],
      },
      {
        price: 520,
        values: [numberOf(memory, 128), choose(colour, 'black'), choose(region, 'US')],
      },
      {
        price: 510,
        values: [numberOf(memory, 128), choose(colour, 'white'), choose(region, 'EU')],
      },
      {
        price: 700,
        values: [numberOf(memory, 256), choose(colour, 'black'), choose(region, 'EU')],
      },
    ]);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    // 128 black (two regions), 128 white, 256 black
    expect(variantIdsOf(res)).toEqual([variantIds[0], variantIds[2], variantIds[3]]);
    expect(rowsOf(res).map((row) => [row.minPrice, row.maxPrice])).toEqual([
      [500, 520],
      [510, 510],
      [700, 700],
    ]);
    expect(res.json().total).toBe(3);
  });

  it('gives a product with no main characteristic one row, its sizes in the group', async () => {
    const category = (await createCategory()).id;
    const { product, variantIds } = await makeProduct(category, [
      { price: 5, values: [choose(size, 'S')] },
      { price: 7, values: [choose(size, 'M')] },
      { price: 6, values: [choose(size, 'L')] },
    ]);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    const [row, ...rest] = rowsOf(res);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      product: { id: product.id },
      variant: { id: variantIds[0] },
      minPrice: 5,
      maxPrice: 7,
      stock: 15,
    });
    expect(res.json().total).toBe(1);
  });

  it('gives a product with no value at all one row too', async () => {
    const category = (await createCategory()).id;
    const { variantIds } = await makeProduct(category, [{ price: 5 }, { price: 6 }, { price: 7 }]);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    expect(variantIdsOf(res)).toEqual([variantIds[0]]);
    expect(rowsOf(res)[0]).toMatchObject({ minPrice: 5, maxPrice: 7 });
  });

  it('makes a variant without a value of a main characteristic a group of its own', async () => {
    const category = (await createCategory()).id;
    // two variants have no colour: for the colour they are equal, and differ from black
    const { variantIds } = await makeProduct(category, [
      { price: 10, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 11, values: [choose(size, 'S')] },
      { price: 12, values: [choose(size, 'M')] },
      { price: 13, values: [choose(colour, 'black'), choose(size, 'M')] },
    ]);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    // black (10 and 13) and none (11 and 12)
    expect(variantIdsOf(res)).toEqual([variantIds[0], variantIds[1]]);
    expect(rowsOf(res).map((row) => [row.minPrice, row.maxPrice])).toEqual([
      [10, 13],
      [11, 12],
    ]);
    expect(res.json().total).toBe(2);
  });

  it('compares a number of a main characteristic as a number', async () => {
    const category = (await createCategory()).id;
    const { variantIds } = await makeProduct(category, [
      { price: 10, values: [numberOf(memory, 128), choose(size, 'S')] },
      { price: 11, values: [numberOf(memory, 128), choose(size, 'M')] },
      { price: 12, values: [numberOf(memory, 256), choose(size, 'S')] },
    ]);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    expect(variantIdsOf(res)).toEqual([variantIds[0], variantIds[2]]);
  });

  it('merges a yes/no main characteristic by its answer', async () => {
    const category = (await createCategory()).id;
    const waterproof = await createAttribute({ type: 'boolean', isMain: true });
    const { variantIds } = await makeProduct(category, [
      { price: 10, values: [answerOf(waterproof, true), choose(size, 'S')] },
      { price: 11, values: [answerOf(waterproof, false), choose(size, 'S')] },
      { price: 12, values: [answerOf(waterproof, true), choose(size, 'M')] },
    ]);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    expect(variantIdsOf(res)).toEqual([variantIds[0], variantIds[1]]);
    expect(rowsOf(res)[0]).toMatchObject({ minPrice: 10, maxPrice: 12 });
  });

  it('never merges the variants of two products', async () => {
    const category = (await createCategory()).id;
    const first = await makeProduct(category, [
      { price: 10, values: [choose(colour, 'black')] },
      { price: 11, values: [choose(colour, 'white')] },
    ]);
    const second = await makeProduct(category, [{ price: 12, values: [choose(colour, 'black')] }]);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    expect(variantIdsOf(res)).toEqual([
      first.variantIds[0],
      first.variantIds[1],
      second.variantIds[0],
    ]);
  });

  it('forgets that a characteristic is main once it is not, and the groups follow at once', async () => {
    const category = (await createCategory()).id;
    const flavour = await createChoice(['mint', 'lemon'], { isMain: true });
    const { variantIds } = await makeProduct(category, [
      { price: 10, values: [choose(flavour, 'mint')] },
      { price: 11, values: [choose(flavour, 'lemon')] },
    ]);
    const query = { categoryIds: String(category), sort: 'price', order: 'asc' };

    expect(variantIdsOf(await list(query))).toEqual([variantIds[0], variantIds[1]]);
    await asAdmin((tx) =>
      tx.attribute.update({ where: { id: flavour.attribute.id }, data: { isMain: false } }),
    );

    expect(variantIdsOf(await list(query))).toEqual([variantIds[0]]);
  });
});

describe('what a group holds', () => {
  it('holds only the variants the price filter finds, the lowest and the highest of them', async () => {
    const category = (await createCategory()).id;
    const { variantIds } = await makeProduct(category, [
      { price: 10, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 30, values: [choose(colour, 'black'), choose(size, 'M')] },
      { price: 20, values: [choose(colour, 'white'), choose(size, 'S')] },
    ]);
    const query = { categoryIds: String(category), sort: 'price', order: 'asc' };

    const high = await list({ ...query, minPrice: '15' });
    const low = await list({ ...query, maxPrice: '25' });

    // black keeps only the medium T-shirt: it stands for the group and fixes its price
    expect(variantIdsOf(high)).toEqual([variantIds[2], variantIds[1]]);
    expect(rowsOf(high).map((row) => [row.minPrice, row.maxPrice, row.stock])).toEqual([
      [20, 20, 5],
      [30, 30, 5],
    ]);
    expect(high.json().total).toBe(2);
    expect(variantIdsOf(low)).toEqual([variantIds[0], variantIds[2]]);
  });

  it('holds prices that differ inside the limits of the filter', async () => {
    const category = (await createCategory()).id;
    const { variantIds } = await makeProduct(category, [
      { price: 10, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 12, values: [choose(colour, 'black'), choose(size, 'M')] },
      { price: 40, values: [choose(colour, 'black'), choose(size, 'L')] },
    ]);

    const res = await list({ categoryIds: String(category), maxPrice: '15' });

    const [row, ...rest] = rowsOf(res);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ variant: { id: variantIds[0] }, minPrice: 10, maxPrice: 12 });
  });

  it('counts the price a variant sells at now, the sale price while a sale lasts', async () => {
    const category = (await createCategory()).id;
    const { variantIds } = await makeProduct(category, [
      { price: 20, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 30, values: [choose(colour, 'black'), choose(size, 'M')] },
      { price: 10, values: [choose(colour, 'white'), choose(size, 'S')] },
    ]);
    await putOnSale({ variantId: variantIds[1]! }, 5);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    // black sells at 20 and at 5: it stands at 5, before white at 10; its first variant stands for it
    expect(variantIdsOf(res)).toEqual([variantIds[0], variantIds[2]]);
    expect(rowsOf(res)[0]).toMatchObject({ minPrice: 5, maxPrice: 20 });
    expect(rowsOf(res)[0]!.variant).toMatchObject({ id: variantIds[0], price: 20 });
    expect(rowsOf(res)[0]!.variant).not.toHaveProperty('salePrice');
  });

  it('shows the first variant of the group by its place, not the cheapest, with its own picture', async () => {
    const category = (await createCategory()).id;
    const { product, variantIds } = await makeProduct(category, [
      { price: 30, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 10, values: [choose(colour, 'black'), choose(size, 'M')] },
    ]);
    // the variants show pictures of their own
    const other = await addGalleryImage(product.id);
    await asAdmin(async (tx) => {
      await tx.variantImage.deleteMany({ where: { variantId: variantIds[1]! } });
      await tx.variantImage.create({
        data: { variantId: variantIds[1]!, imageId: other, position: 1 },
      });
    });

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });
    const first = await app.inject({
      method: 'GET',
      url: `/api/products/${product.id}/variants/${variantIds[0]}`,
    });
    const second = await app.inject({
      method: 'GET',
      url: `/api/products/${product.id}/variants/${variantIds[1]}`,
    });

    const [row] = rowsOf(res);
    // the group stands at 10 (the cheaper variant) and shows the first variant, at 30
    expect(row!.variant.id).toBe(variantIds[0]);
    expect(row!.variant.price).toBe(30);
    expect(row).toMatchObject({ minPrice: 10, maxPrice: 30 });
    expect(row!.variant.image).toEqual(first.json().image);
    expect(row!.variant.image).not.toEqual(second.json().image);
  });

  it('adds up the free units of the variants of the group', async () => {
    const category = (await createCategory()).id;
    await makeProduct(category, [
      { price: 10, stock: 0, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 11, stock: 4, values: [choose(colour, 'black'), choose(size, 'M')] },
      { price: 12, stock: 3, values: [choose(colour, 'black'), choose(size, 'L')] },
    ]);

    const [row] = rowsOf(await list({ categoryIds: String(category), minPrice: '0' }));

    expect(row!.stock).toBe(7);
  });

  it('keeps the variants with free units, and the group of them alone, when inStock is asked', async () => {
    const category = (await createCategory()).id;
    const { variantIds } = await makeProduct(category, [
      { price: 10, stock: 0, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 11, stock: 4, values: [choose(colour, 'black'), choose(size, 'M')] },
    ]);
    const query = { categoryIds: String(category), sort: 'price', order: 'asc' };

    const inStock = await list({ ...query, inStock: 'true' });
    const soldOut = await list({ ...query, inStock: 'false' });

    expect(variantIdsOf(inStock)).toEqual([variantIds[1]]);
    expect(rowsOf(inStock)[0]).toMatchObject({ minPrice: 11, maxPrice: 11, stock: 4 });
    expect(variantIdsOf(soldOut)).toEqual([variantIds[0]]);
    expect(rowsOf(soldOut)[0]!.stock).toBe(0);
  });
});

describe('the variants a buyer does not see', () => {
  it('leaves a hidden variant out of its group: the price, the units and the first of the group', async () => {
    const category = (await createCategory()).id;
    const { variantIds } = await makeProduct(category, [
      { price: 5, stock: 9, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 20, stock: 2, values: [choose(colour, 'black'), choose(size, 'M')] },
      { price: 1, stock: 9, values: [choose(colour, 'black'), choose(size, 'L')] },
    ]);
    // the first variant is taken out of sale, the third shows no picture
    await markVariantDeleted(variantIds[0]!);
    await stripVariantImages(variantIds[2]!);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    const [row, ...rest] = rowsOf(res);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      variant: { id: variantIds[1] },
      minPrice: 20,
      maxPrice: 20,
      stock: 2,
    });
    expect(res.json().total).toBe(1);
  });

  it('lists no group of hidden variants only', async () => {
    const category = (await createCategory()).id;
    const { variantIds } = await makeProduct(category, [
      { price: 5, values: [choose(colour, 'black')] },
      { price: 6, values: [choose(colour, 'white')] },
    ]);
    await markVariantDeleted(variantIds[0]!);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    expect(variantIdsOf(res)).toEqual([variantIds[1]]);
    expect(res.json().total).toBe(1);
  });

  it('lists no product whose variants are all hidden, in a group list or in a product list', async () => {
    const category = (await createCategory()).id;
    const { variantIds } = await makeProduct(category, [
      { price: 5, values: [choose(colour, 'black')] },
      { price: 6, values: [choose(colour, 'white')] },
    ]);
    await markVariantDeleted(variantIds[0]!);
    await stripVariantImages(variantIds[1]!);

    const grouped = await list({ categoryIds: String(category), sort: 'price' });
    const plain = await list({ categoryIds: String(category) });

    expect(rowsOf(grouped)).toEqual([]);
    expect(grouped.json().total).toBe(0);
    expect(rowsOf(plain)).toEqual([]);
    expect(plain.json().total).toBe(0);
  });

  it('gives an admin the groups of the variants that are alive, the ones without a picture too', async () => {
    const category = (await createCategory()).id;
    const { variantIds } = await makeProduct(category, [
      { price: 5, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 7, values: [choose(colour, 'black'), choose(size, 'M')] },
      { price: 9, values: [choose(colour, 'white'), choose(size, 'S')] },
    ]);
    await stripVariantImages(variantIds[0]!);
    await markVariantDeleted(variantIds[2]!);
    const query = { categoryIds: String(category), sort: 'price', order: 'asc' };

    const asAdmin = await list(query, admin);
    const asBuyer = await list(query);

    // the admin: black with both of its variants (the first shows no picture), white is taken out
    expect(variantIdsOf(asAdmin)).toEqual([variantIds[0]]);
    expect(rowsOf(asAdmin)[0]).toMatchObject({ minPrice: 5, maxPrice: 7, stock: 10 });
    expect(rowsOf(asAdmin)[0]!.variant).toMatchObject({ visible: false });
    // a buyer: the medium one alone
    expect(variantIdsOf(asBuyer)).toEqual([variantIds[1]]);
  });
});

describe('the kind of the rows', () => {
  it('gives a row for a product while the query asks nothing of a variant, groups when it does', async () => {
    const category = (await createCategory()).id;
    const { product, variantIds } = await makeProduct(category, [
      { price: 20, values: [choose(colour, 'black')] },
      { price: 30, values: [choose(colour, 'white')] },
    ]);

    const products = await list({ categoryIds: String(category) });
    const groups = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });
    const filtered = await list({ categoryIds: String(category), minPrice: '0' });

    expect(rowsOf(products).map((row) => row.product.id)).toEqual([product.id]);
    expect(rowsOf(products)[0]).toMatchObject({ minPrice: 20, maxPrice: 30, stock: 10 });
    expect(products.json().total).toBe(1);
    expect(variantIdsOf(groups)).toEqual([variantIds[0], variantIds[1]]);
    expect(filtered.json().total).toBe(2);
  });
});

describe('the pages of a list of groups', () => {
  // three products with a black and a white group that share their lowest price, two products with
  // one price: every group ties with the others at 10 going up, the white ones tie at 14 going down
  async function tiedGroups() {
    const category = (await createCategory()).id;
    const groups: { id: number; min: number; max: number }[] = [];
    for (let n = 0; n < 3; n += 1) {
      const { variantIds } = await makeProduct(category, [
        { price: 10, values: [choose(colour, 'black'), choose(size, 'S')] },
        { price: 12, values: [choose(colour, 'black'), choose(size, 'M')] },
        { price: 10, values: [choose(colour, 'white'), choose(size, 'S')] },
        { price: 14, values: [choose(colour, 'white'), choose(size, 'M')] },
      ]);
      groups.push({ id: variantIds[0]!, min: 10, max: 12 });
      groups.push({ id: variantIds[2]!, min: 10, max: 14 });
    }
    for (let n = 0; n < 2; n += 1) {
      const { variantIds } = await makeProduct(category, [{ price: 10 }]);
      groups.push({ id: variantIds[0]!, min: 10, max: 10 });
    }

    return { category: String(category), groups };
  }

  it('walks the groups going up: the lowest price, a tie by the first variant, none twice or lost', async () => {
    const { category, groups } = await tiedGroups();
    const expected = [...groups].sort((a, b) => a.min - b.min || a.id - b.id).map((g) => g.id);

    for (const size of [1, 3, 8, 20]) {
      const { ids, totals } = await walk(
        { categoryIds: category, sort: 'price', order: 'asc' },
        size,
      );

      expect(ids).toEqual(expected);
      expect(totals).toEqual(new Set([8]));
    }
  });

  it('walks the groups going down: the highest price, a tie by the first variant, none twice or lost', async () => {
    const { category, groups } = await tiedGroups();
    const expected = [...groups].sort((a, b) => b.max - a.max || b.id - a.id).map((g) => g.id);

    for (const size of [1, 3, 8]) {
      const { ids, totals } = await walk(
        { categoryIds: category, sort: 'price', order: 'desc' },
        size,
      );

      expect(ids).toEqual(expected);
      expect(totals).toEqual(new Set([8]));
    }
  });

  it('walks the groups of a sort that is not about the price, the group tied by its product', async () => {
    const { category, groups } = await tiedGroups();

    // the popularity of a product is shared by its groups: the first variant of the group decides
    const { ids } = await walk({ categoryIds: category, sort: 'popularity', minPrice: '0' }, 3);

    expect(ids).toEqual(groups.map((g) => g.id).sort((a, b) => b - a));
  });

  it('walks the groups of a filter of the price that takes part of each group', async () => {
    const { category, groups } = await tiedGroups();

    // the price filter keeps the cheap variants: every group of a product with a black and a white
    // keeps its first variant, the others do not change
    const { ids, totals } = await walk(
      { categoryIds: category, sort: 'price', order: 'asc', maxPrice: '10' },
      2,
    );

    expect(ids).toEqual(groups.map((g) => g.id).sort((a, b) => a - b));
    expect(totals).toEqual(new Set([8]));
  });

  it('walks the groups of the sale sorts of a buyer: the groups with a sale first, the rest after them', async () => {
    const category = (await createCategory()).id;
    const first = await makeProduct(category, [
      { price: 100, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 100, values: [choose(colour, 'black'), choose(size, 'M')] },
      { price: 100, values: [choose(colour, 'white')] },
    ]);
    const second = await makeProduct(category, [
      { price: 100, values: [choose(colour, 'black')] },
      { price: 100, values: [choose(colour, 'white')] },
    ]);
    // black of the first product: one variant at 50 (the soonest end), one at 70 (the latest end);
    // black of the second: at 80, ending between them
    await putOnSale({ variantId: first.variantIds[0]! }, 50, DAY);
    await putOnSale({ variantId: first.variantIds[1]! }, 70, 3 * DAY);
    await putOnSale({ variantId: second.variantIds[0]! }, 80, 2 * DAY);
    const query = { categoryIds: String(category) };

    // the discount, the biggest first: the first black (50 off) and the second black (20 off)
    const byDiscount = await walk({ ...query, sort: 'discount', order: 'desc' }, 1);
    // the end of the sale going up: a group stands at its soonest end (1 day, 2 days)
    const soonest = await walk({ ...query, sort: 'saleEndsAt', order: 'asc' }, 2);
    // going down a group stands at its latest end (3 days, 2 days)
    const latest = await walk({ ...query, sort: 'saleEndsAt', order: 'desc' }, 1);

    const sale = [first.variantIds[0], second.variantIds[0]];
    expect(byDiscount.ids.slice(0, 2)).toEqual(sale);
    expect(soonest.ids.slice(0, 2)).toEqual(sale);
    expect(latest.ids.slice(0, 2)).toEqual(sale);
    // the rest: the white groups, by the popularity of the product they share, the newer first
    const rest = [first.variantIds[2], second.variantIds[1]].sort((a, b) => b! - a!);
    for (const walked of [byDiscount, soonest, latest]) {
      expect(walked.ids.slice(2)).toEqual(rest);
      expect(new Set(walked.ids).size).toBe(4);
    }
    expect(byDiscount.totals).toEqual(new Set([4]));
  });

  it('puts the sooner group first going down when the later one ends later', async () => {
    const category = (await createCategory()).id;
    const first = await makeProduct(category, [
      { price: 100, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 100, values: [choose(colour, 'black'), choose(size, 'M')] },
    ]);
    const second = await makeProduct(category, [{ price: 100, values: [choose(colour, 'black')] }]);
    await putOnSale({ variantId: first.variantIds[0]! }, 50, DAY);
    await putOnSale({ variantId: first.variantIds[1]! }, 70, 3 * DAY);
    await putOnSale({ variantId: second.variantIds[0]! }, 80, 2 * DAY);

    const res = await list({ categoryIds: String(category), sort: 'saleEndsAt', order: 'desc' });

    // the first black ends at 3 days at the latest, the second black at 2
    expect(variantIdsOf(res)).toEqual([first.variantIds[0], second.variantIds[0]]);
  });
});

describe('the cursor of a list of groups', () => {
  it('is no cursor of a list of products or of single variants', async () => {
    const category = (await createCategory()).id;
    await makeProduct(category, [
      { price: 10, values: [choose(colour, 'black')] },
      { price: 11, values: [choose(colour, 'white')] },
    ]);
    await makeProduct(category, [{ price: 12 }]);
    const query = { categoryIds: String(category), sort: 'price', order: 'asc', limit: '1' };

    const groups = await list(query, admin);
    const variants = await list({ ...query, group: 'false' }, admin);
    const products = await list({ categoryIds: String(category), limit: '1' }, admin);

    const groupCursor = groups.json().nextCursor as string;
    const variantCursor = variants.json().nextCursor as string;
    const productCursor = products.json().nextCursor as string;
    const crossings = [
      await list({ ...query, group: 'false', cursor: groupCursor }, admin),
      await list({ ...query, cursor: variantCursor }, admin),
      await list({ ...query, cursor: productCursor }, admin),
      await list({ categoryIds: String(category), limit: '1', cursor: groupCursor }, admin),
    ];

    for (const res of crossings) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    }
    // and its own cursor goes on
    const next = await list({ ...query, cursor: groupCursor }, admin);
    expect(next.statusCode).toBe(200);
  });
});

describe('the flag group of an admin', () => {
  async function tshirt() {
    const category = (await createCategory()).id;
    const made = await makeProduct(category, [
      { price: 20, stock: 1, values: [choose(colour, 'black'), choose(size, 'S')] },
      { price: 25, stock: 8, values: [choose(colour, 'black'), choose(size, 'M')] },
      { price: 22, stock: 4, values: [choose(colour, 'white'), choose(size, 'S')] },
      { price: 30, stock: 9, values: [choose(colour, 'white'), choose(size, 'M')] },
    ]);

    return { category: String(category), ...made };
  }

  it('gives an admin the groups of a buyer by default, and with group=true', async () => {
    const { category, variantIds } = await tshirt();
    const query = { categoryIds: category, sort: 'price', order: 'asc' };

    const byDefault = await list(query, admin);
    const grouped = await list({ ...query, group: 'true' }, admin);

    expect(variantIdsOf(byDefault)).toEqual([variantIds[0], variantIds[2]]);
    expect(variantIdsOf(grouped)).toEqual([variantIds[0], variantIds[2]]);
    expect(rowsOf(byDefault)[0]).toMatchObject({ minPrice: 20, maxPrice: 25, stock: 9 });
    expect(grouped.json().total).toBe(2);
  });

  it('gives every variant its own row with group=false, with its own units', async () => {
    const { category, variantIds } = await tshirt();

    const res = await list(
      { categoryIds: category, sort: 'price', order: 'asc', group: 'false' },
      admin,
    );

    expect(variantIdsOf(res)).toEqual([variantIds[0], variantIds[2], variantIds[1], variantIds[3]]);
    expect(rowsOf(res).map((row) => row.stock)).toEqual([1, 4, 8, 9]);
    for (const row of rowsOf(res)) {
      expect(row).not.toHaveProperty('minPrice');
      expect(row).not.toHaveProperty('maxPrice');
    }
    expect(res.json().total).toBe(4);
  });

  it('makes group=false list every variant of a plain list, the rows being variants', async () => {
    const { category, variantIds, product } = await tshirt();

    const plain = await list({ categoryIds: category }, admin);
    const flat = await list({ categoryIds: category, group: 'false' }, admin);

    expect(rowsOf(plain).map((row) => row.product.id)).toEqual([product.id]);
    expect(variantIdsOf(flat).sort((a, b) => a - b)).toEqual(variantIds);
    expect(flat.json().total).toBe(4);
  });

  it('walks every variant with group=false across pages', async () => {
    const { category, variantIds } = await tshirt();

    const { ids, totals } = await walk(
      { categoryIds: category, sort: 'price', order: 'desc', group: 'false' },
      3,
      admin,
    );

    expect(ids).toEqual([variantIds[3], variantIds[1], variantIds[2], variantIds[0]]);
    expect(totals).toEqual(new Set([4]));
  });

  it('sorts and filters by the units of the variant, the group standing at its lowest going up and its highest going down', async () => {
    const { category, variantIds } = await tshirt();
    const query = { categoryIds: category, sort: 'stock' };

    const asc = await list({ ...query, order: 'asc' }, admin);
    const desc = await list({ ...query, order: 'desc' }, admin);
    const few = await list({ categoryIds: category, maxStock: '3' }, admin);
    const fewFlat = await list({ categoryIds: category, maxStock: '3', group: 'false' }, admin);

    // black has 1 and 8, white 4 and 9: going up black (1) then white (4), going down white (9)
    // then black (8)
    expect(variantIdsOf(asc)).toEqual([variantIds[0], variantIds[2]]);
    expect(variantIdsOf(desc)).toEqual([variantIds[2], variantIds[0]]);
    // the filter takes the variants of 3 units at most: the small black one alone, and its group
    // holds it only
    expect(variantIdsOf(few)).toEqual([variantIds[0]]);
    expect(rowsOf(few)[0]).toMatchObject({ stock: 1, minPrice: 20, maxPrice: 20 });
    expect(variantIdsOf(fewFlat)).toEqual([variantIds[0]]);
  });

  it('refuses group=false to a buyer, and takes group=true as what a buyer gets', async () => {
    const { category, variantIds } = await tshirt();
    const query = { categoryIds: category, sort: 'price', order: 'asc' };

    const refused = await list({ ...query, group: 'false' });
    const accepted = await list({ ...query, group: 'true' });
    const asUser = await list({ ...query, group: 'false' }, await createUserTracked());

    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      errorCode: 'FILTER_FORBIDDEN',
      details: { filter: 'group' },
    });
    expect(asUser.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    expect(variantIdsOf(accepted)).toEqual([variantIds[0], variantIds[2]]);
  });

  it('takes group as a boolean only', async () => {
    const { category } = await tshirt();

    const res = await list({ categoryIds: category, group: 'maybe' }, admin);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('keeps the flag of the deleted products: their variants are grouped too', async () => {
    const { category, product, variantIds } = await tshirt();
    await deleteProductFromCatalog(product.id);

    const grouped = await list({ categoryIds: category, deleted: 'true', sort: 'price' }, admin);
    const flat = await list(
      { categoryIds: category, deleted: 'true', sort: 'price', group: 'false' },
      admin,
    );

    expect(rowsOf(grouped)).toHaveLength(2);
    expect(rowsOf(flat)).toHaveLength(4);
    expect(variantIdsOf(flat).sort((a, b) => a - b)).toEqual(variantIds);
  });
});

async function createUserTracked() {
  const user = await createUser();
  userIds.push(user.id);
  return user;
}

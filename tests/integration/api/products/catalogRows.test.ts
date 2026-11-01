import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  putOnSale,
  waitForSalesEnd,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { keepApart } from '../../../helpers/characteristics.js';
import { markVariantDeleted, stripVariantImages } from '../../../helpers/variants.js';

// What a row of the catalog list is. With a query that asks nothing of a variant (a category, a
// search, the popularity, the rating, the news, the name) a row is a PRODUCT: its main variant (the
// first by its place that has free units, the first of all when none has), the lowest and the
// highest price its variants sell at now, and the free units of them all. With a query that asks
// something of a variant (a price in the sort or in the filter, the sale, the stock of a variant)
// a row is a GROUP of the variants that fit (the variants of a product with the same main
// characteristics, catalogGroups.test.ts). The products here have no main characteristic, so a test
// that wants a row for each variant gives the variants of a product values of a main characteristic
// that differ (keepApart). A buyer sees only the variants that are for sale with a picture; a
// product with none is in no list. `total` counts the rows, the cursor keeps the row it ends at.
// A test looks at the products of a category of its own

let app: FastifyInstance;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const DAY = 86_400_000;

beforeAll(async () => {
  app = await startApp();
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
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
  variant: Record<string, unknown> & { id: number; price: number; stock: number };
  minPrice?: number;
  maxPrice?: number;
  stock: number;
};

async function newProduct(categoryId: number, opts: Parameters<typeof createProduct>[0] = {}) {
  const product = await createProduct({ categoryId, price: 10, stock: 5, ...opts });
  products.push(product);
  return product;
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

const productIdsOf = (res: LightMyRequestResponse) => rowsOf(res).map((row) => row.product.id);
const variantIdsOf = (res: LightMyRequestResponse) => rowsOf(res).map((row) => row.variant.id);

// every page of a list by the cursor, `size` rows a page: the ids of the rows (the variants or the
// products), and the number of pages
async function walk(
  query: Record<string, string>,
  size: number,
  pick: (row: Row) => number,
  actor?: TestUser,
) {
  const ids: number[] = [];
  let pages = 0;
  let cursor: string | undefined;
  do {
    const res = await list({ ...query, limit: String(size), ...(cursor ? { cursor } : {}) }, actor);
    ids.push(...rowsOf(res).map(pick));
    cursor = res.json().nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < 50);

  return { ids, pages };
}

describe('the rows are products', () => {
  let categoryId: number;

  beforeAll(async () => {
    ({ id: categoryId } = await createCategory());
  });

  it('gives one row to a product with several variants, with its main variant', async () => {
    const category = (await createCategory()).id;
    // the first variant has no free units, the second one has, the third too
    const product = await newProduct(category, { price: 10, stock: 0 });
    const second = await createVariant(product.id, { price: 30, stock: 2 });
    await createVariant(product.id, { price: 20, stock: 4 });

    const res = await list({ categoryIds: String(category) });

    const [row, ...rest] = rowsOf(res);
    expect(rest).toEqual([]);
    expect(row!.product.id).toBe(product.id);
    // the first by its place with free units
    expect(row!.variant.id).toBe(second.id);
    expect(row!.minPrice).toBe(10);
    expect(row!.maxPrice).toBe(30);
    expect(row!.stock).toBe(6);
    expect(res.json().total).toBe(1);
  });

  it('shows the first variant when none has free units', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10, stock: 0 });
    await createVariant(product.id, { price: 20, stock: 0 });

    const [row] = rowsOf(await list({ categoryIds: String(category) }));

    expect(row!.variant.id).toBe(product.variantId);
    expect(row!.stock).toBe(0);
  });

  it('gives the lowest and the highest price the variants sell at now, a sale counted', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10 });
    const dear = await createVariant(product.id, { price: 30 });
    await createVariant(product.id, { price: 20 });
    // the first variant sells at 4, the dear one at 25 (the usual price is not the lowest or the highest)
    await putOnSale({ variantId: product.variantId }, 4);
    await putOnSale({ variantId: dear.id }, 25);

    const [row] = rowsOf(await list({ categoryIds: String(category) }));

    expect(row!.minPrice).toBe(4);
    expect(row!.maxPrice).toBe(25);
    // the variant of the row shows its own sale and its usual price
    expect(row!.variant).toMatchObject({ id: product.variantId, price: 10, salePrice: 4 });
  });

  it('gives a product with one price the same minimum and maximum', async () => {
    const category = (await createCategory()).id;
    await newProduct(category, { price: 12.5 });

    const [row] = rowsOf(await list({ categoryIds: String(category) }));

    expect(row).toMatchObject({ minPrice: 12.5, maxPrice: 12.5 });
  });

  it('counts a sale that is over as no price', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 20 });
    // a sale that is over stays in the row and sells at nothing
    await putOnSale({ variantId: product.variantId }, 5, 1500);
    await waitForSalesEnd([product.id]);

    const [row] = rowsOf(await list({ categoryIds: String(category) }));

    expect(row).toMatchObject({ minPrice: 20, maxPrice: 20 });
    expect(row!.variant).not.toHaveProperty('salePrice');
  });

  it('leaves the variants a buyer does not see out of the prices, the stock and the main variant', async () => {
    const category = (await createCategory()).id;
    // the first variant is taken out of sale, the second shows no picture: only the third is seen
    const product = await newProduct(category, { price: 1, stock: 9 });
    const bare = await createVariant(product.id, { price: 2, stock: 9 });
    const seen = await createVariant(product.id, { price: 50, stock: 3 });
    await markVariantDeleted(product.variantId);
    await stripVariantImages(bare.id);

    const [row, ...rest] = rowsOf(await list({ categoryIds: String(category) }));

    expect(rest).toEqual([]);
    expect(row!.variant.id).toBe(seen.id);
    expect(row).toMatchObject({ minPrice: 50, maxPrice: 50, stock: 3 });
  });

  it('lists no product none of whose variants a buyer sees, and an admin lists it', async () => {
    const category = (await createCategory()).id;
    const seen = await newProduct(category);
    const withoutPicture = await newProduct(category);
    const taken = await newProduct(category);
    const gone = await newProduct(category);
    await stripVariantImages(withoutPicture.variantId);
    await markVariantDeleted(taken.variantId);
    await deleteProductFromCatalog(gone.id);

    const buyer = await list({ categoryIds: String(category) });
    const asAdmin = await list({ categoryIds: String(category) }, admin);

    expect(productIdsOf(buyer)).toEqual([seen.id]);
    expect(buyer.json().total).toBe(1);
    // the deleted product has its own flag; the other two stay in the list of an admin
    expect(productIdsOf(asAdmin).sort((a, b) => a - b)).toEqual(
      [seen.id, withoutPicture.id, taken.id].sort((a, b) => a - b),
    );
    expect(asAdmin.json().total).toBe(3);
  });

  it('gives an admin the full variant and the prices over the variants that are alive', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10, stock: 2 });
    const removed = await createVariant(product.id, { price: 1, stock: 1 });
    const bare = await createVariant(product.id, { price: 40, stock: 1 });
    await markVariantDeleted(removed.id);
    await stripVariantImages(bare.id);

    const [row] = rowsOf(await list({ categoryIds: String(category) }, admin));

    // the variants alive count for an admin, the one without a picture too
    expect(row).toMatchObject({ minPrice: 10, maxPrice: 40, stock: 3 });
    expect(row!.variant).toMatchObject({
      id: product.variantId,
      sku: null,
      images: expect.any(Array),
      totalStock: 2,
      reservedStock: 0,
      expiredStock: 0,
      visible: true,
      deletedAt: null,
    });
  });

  it('lists a product whose variants are all taken out of sale to an admin, with the first of them', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category);
    await markVariantDeleted(product.variantId);

    const [row] = rowsOf(await list({ categoryIds: String(category) }, admin));

    expect(row!.product.id).toBe(product.id);
    expect(row!.variant).toMatchObject({ id: product.variantId, visible: false });
    expect(row!.variant.deletedAt).toEqual(expect.any(String));
    // no variant alive: no price to show, no free units
    expect(row).not.toHaveProperty('minPrice');
    expect(row!.stock).toBe(0);
  });

  it('shows the variants of a product that was taken out in the list of the deleted products', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10, stock: 2 });
    await createVariant(product.id, { price: 20, stock: 1 });
    await deleteProductFromCatalog(product.id);

    const res = await list({ categoryIds: String(category), deleted: 'true' }, admin);

    const [row, ...rest] = rowsOf(res);
    expect(rest).toEqual([]);
    expect(row!.product).toMatchObject({ id: product.id, deletedAt: expect.any(String) });
    expect(row!.variant.deletedAt).toEqual(expect.any(String));
    expect(row).toMatchObject({ minPrice: 10, maxPrice: 20, stock: 3 });
    // and the list of the rest does not have it
    expect(productIdsOf(await list({ categoryIds: String(category) }, admin))).toEqual([]);
  });

  it('lists a product by a sort that is not about a variant as one row', async () => {
    const product = await newProduct(categoryId);
    await createVariant(product.id, { price: 11 });
    await createVariant(product.id, { price: 12 });

    for (const sort of ['popularity', 'createdAt', 'name', 'avgRating', 'sales']) {
      const res = await list({ categoryIds: String(categoryId), sort });

      expect(productIdsOf(res).filter((id) => id === product.id)).toEqual([product.id]);
    }
  });
});

describe('the rows are variants', () => {
  it('gives a row to each variant that a sort by the price puts in order', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 30 });
    const cheap = await createVariant(product.id, { price: 10 });
    const middle = await createVariant(product.id, { price: 20 });
    const other = await newProduct(category, { price: 15 });
    await keepApart([product.variantId, cheap.id, middle.id]);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    expect(variantIdsOf(res)).toEqual([cheap.id, other.variantId, middle.id, product.variantId]);
    expect(res.json().total).toBe(4);
    const [first] = rowsOf(res);
    // a row of one variant has its product, its variant, its free units and the one price as the
    // lowest and the highest
    expect(first).toMatchObject({
      product: { id: product.id },
      variant: { id: cheap.id },
      stock: 5,
      minPrice: 10,
      maxPrice: 10,
    });
  });

  it('orders by the price the variant sells at now, going desc too', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 30 });
    const sold = await createVariant(product.id, { price: 40 });
    await keepApart([product.variantId, sold.id]);
    await putOnSale({ variantId: sold.id }, 5);

    const asc = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });
    const desc = await list({ categoryIds: String(category), sort: 'price', order: 'desc' });

    expect(variantIdsOf(asc)).toEqual([sold.id, product.variantId]);
    expect(variantIdsOf(desc)).toEqual([product.variantId, sold.id]);
  });

  it('keeps the variants whose price is in the range of the filter, the sale price counted', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10 });
    const dear = await createVariant(product.id, { price: 40 });
    const sold = await createVariant(product.id, { price: 50 });
    await keepApart([product.variantId, dear.id, sold.id]);
    // the dear one is on sale at 12, the usual price of the other is far above
    await putOnSale({ variantId: sold.id }, 12);

    const low = await list({ categoryIds: String(category), maxPrice: '12' });
    const high = await list({ categoryIds: String(category), minPrice: '30' });
    const exact = await list({ categoryIds: String(category), minPrice: '12', maxPrice: '12' });

    expect(variantIdsOf(low).sort((a, b) => a - b)).toEqual([product.variantId, sold.id]);
    expect(variantIdsOf(high)).toEqual([dear.id]);
    expect(variantIdsOf(exact)).toEqual([sold.id]);
    expect(low.json().total).toBe(2);
  });

  it('lists a product with several variants in the range as a row for each, and one without none', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10 });
    const near = await createVariant(product.id, { price: 11 });
    const far = await createVariant(product.id, { price: 500 });
    await keepApart([product.variantId, near.id, far.id]);

    const res = await list({ categoryIds: String(category), minPrice: '5', maxPrice: '20' });

    expect(variantIdsOf(res).sort((a, b) => a - b)).toEqual([product.variantId, near.id]);
    expect(rowsOf(res).every((row) => row.product.id === product.id)).toBe(true);
  });

  it('leaves out the variants a buyer does not see, and the admin has the ones that are alive', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10 });
    const bare = await createVariant(product.id, { price: 11 });
    const removed = await createVariant(product.id, { price: 12 });
    await keepApart([product.variantId, bare.id, removed.id]);
    await stripVariantImages(bare.id);
    await markVariantDeleted(removed.id);
    const query = { categoryIds: String(category), sort: 'price', order: 'asc' };

    const buyer = await list(query);
    const asAdmin = await list(query, admin);

    expect(variantIdsOf(buyer)).toEqual([product.variantId]);
    expect(variantIdsOf(asAdmin)).toEqual([product.variantId, bare.id]);
    expect(rowsOf(asAdmin)[1]!.variant).toMatchObject({ id: bare.id, visible: false, image: null });
  });

  it('lists the variants of a product that was taken out with the flag of the deleted ones', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10 });
    const second = await createVariant(product.id, { price: 20 });
    await keepApart([product.variantId, second.id]);
    await deleteProductFromCatalog(product.id);
    const query = { categoryIds: String(category), sort: 'price', order: 'asc' };

    const plain = await list(query, admin);
    const flagged = await list({ ...query, deleted: 'true' }, admin);

    expect(variantIdsOf(plain)).toEqual([]);
    expect(variantIdsOf(flagged)).toEqual([product.variantId, second.id]);
    expect(rowsOf(flagged)[0]!.variant.deletedAt).toEqual(expect.any(String));
  });

  it('lists only the variants on sale with the flag of an admin, a product with one on sale among the rest', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10 });
    const sold = await createVariant(product.id, { price: 20 });
    await keepApart([product.variantId, sold.id]);
    await putOnSale({ variantId: sold.id }, 8);

    const flagged = await list({ categoryIds: String(category), onSale: 'true' }, admin);
    const plain = await list({ categoryIds: String(category) }, admin);
    const buyer = await list({ categoryIds: String(category), sort: 'price', order: 'asc' });

    // the flag: the variant on sale alone, as a row of its own
    expect(variantIdsOf(flagged)).toEqual([sold.id]);
    expect(rowsOf(flagged)[0]!.variant).toMatchObject({ price: 20, salePrice: 8 });
    // no flag: the plain products, and a product with a sale on a variant is not a plain one
    expect(productIdsOf(plain)).toEqual([]);
    // a buyer sees both variants, sale or not
    expect(variantIdsOf(buyer)).toEqual([sold.id, product.variantId]);
  });

  it('gives the plain variants only when an admin sorts by the price without a flag', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10 });
    const sold = await createVariant(product.id, { price: 20 });
    await keepApart([product.variantId, sold.id]);
    await putOnSale({ variantId: sold.id }, 8);

    const res = await list({ categoryIds: String(category), sort: 'price', order: 'asc' }, admin);

    expect(variantIdsOf(res)).toEqual([product.variantId]);
  });

  it('filters the variants of an admin by the usual price', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10 });
    const second = await createVariant(product.id, { price: 40 });
    await keepApart([product.variantId, second.id]);
    await putOnSale({ variantId: second.id }, 5);

    const res = await list(
      { categoryIds: String(category), onSale: 'true', minPrice: '30', maxPrice: '50' },
      admin,
    );

    expect(variantIdsOf(res)).toEqual([second.id]);
  });

  it('sorts the variants by the sales of their product, a tie by the id of the variant', async () => {
    const category = (await createCategory()).id;
    const first = await newProduct(category, { price: 10 });
    const more = await createVariant(first.id, { price: 11 });
    await keepApart([first.variantId, more.id]);
    const second = await newProduct(category, { price: 12 });
    // nothing was sold in that month: every product ties at 0
    const period = {
      salesFrom: '2000-01-01T00:00:00.000Z',
      salesTo: '2000-02-01T00:00:00.000Z',
    };

    const res = await list({
      categoryIds: String(category),
      sort: 'sales',
      minPrice: '0',
      ...period,
    });
    const asc = await list({
      categoryIds: String(category),
      sort: 'sales',
      order: 'asc',
      minPrice: '0',
      ...period,
    });

    expect(variantIdsOf(res)).toEqual([second.variantId, more.id, first.variantId]);
    expect(variantIdsOf(asc)).toEqual([first.variantId, more.id, second.variantId]);
  });
});

// the pages neither skip nor repeat a row: the id of the row (a variant, or a product) breaks the
// ties of the sort, and the cursor knows which kind of row it ends at
describe('the pages by the cursor', () => {
  it('walks the products of a list, a tie of the sort too', async () => {
    const category = (await createCategory()).id;
    const made: TestProduct[] = [];
    for (let n = 0; n < 5; n += 1) made.push(await newProduct(category));
    // every product has the same rating and popularity: the id decides
    const ids = made.map((product) => product.id).sort((a, b) => b - a);

    for (const sort of ['avgRating', 'popularity']) {
      const { ids: seen, pages } = await walk(
        { categoryIds: String(category), sort },
        2,
        (row) => row.product.id,
      );

      expect(seen).toEqual(ids);
      expect(pages).toBe(3);
    }
    const asc = await walk(
      { categoryIds: String(category), sort: 'avgRating', order: 'asc' },
      2,
      (row) => row.product.id,
    );
    expect(asc.ids).toEqual([...ids].reverse());
  });

  it('walks the variants of a list, the variants of one product tied by the sort of the product', async () => {
    const category = (await createCategory()).id;
    const variantIds: number[] = [];
    for (let n = 0; n < 3; n += 1) {
      const product = await newProduct(category);
      variantIds.push(product.variantId);
      variantIds.push((await createVariant(product.id, { price: 11 })).id);
      await keepApart(variantIds.slice(-2));
    }
    const expected = [...variantIds].sort((a, b) => b - a);

    // the rows are variants because of the price filter; the sort is the popularity of the product,
    // which the variants of a product share
    const { ids, pages } = await walk(
      { categoryIds: String(category), sort: 'popularity', minPrice: '0' },
      4,
      (row) => row.variant.id,
    );

    expect(ids).toEqual(expected);
    expect(pages).toBe(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('walks the variants sorted by a price that several of them share', async () => {
    const category = (await createCategory()).id;
    const variantIds: number[] = [];
    for (let n = 0; n < 3; n += 1) {
      const product = await newProduct(category, { price: 10 });
      variantIds.push(product.variantId);
      variantIds.push((await createVariant(product.id, { price: 10 })).id);
      await keepApart(variantIds.slice(-2));
    }

    const desc = await walk(
      { categoryIds: String(category), sort: 'price', order: 'desc' },
      1,
      (row) => row.variant.id,
    );
    const asc = await walk(
      { categoryIds: String(category), sort: 'price', order: 'asc' },
      4,
      (row) => row.variant.id,
    );

    // one price: the id of the variant decides, in the direction of the sort
    expect(desc.ids).toEqual([...variantIds].sort((a, b) => b - a));
    expect(asc.ids).toEqual([...variantIds].sort((a, b) => a - b));
  });

  it('walks the variants by the price they sell at now, a sale among them', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 10 });
    const variants = [product.variantId];
    for (const price of [12, 12, 30]) {
      variants.push((await createVariant(product.id, { price })).id);
    }
    await keepApart(variants);
    // the last one sells at 12 too, as a sale
    await putOnSale({ variantId: variants[3]! }, 12);

    const { ids } = await walk(
      { categoryIds: String(category), sort: 'price', order: 'asc' },
      1,
      (row) => row.variant.id,
    );

    expect(ids).toEqual([variants[0], variants[1], variants[2], variants[3]]);
  });

  it('walks the variants of a buyer sale sort, the variants on sale first and the rest after them', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category, { price: 100 });
    const variants = [product.variantId];
    for (let n = 0; n < 4; n += 1)
      variants.push((await createVariant(product.id, { price: 100 })).id);
    await keepApart(variants);
    await putOnSale({ variantId: variants[1]! }, 50, DAY);
    await putOnSale({ variantId: variants[2]! }, 70, 2 * DAY);

    for (const sort of ['saleEndsAt', 'discount']) {
      const { ids } = await walk(
        { categoryIds: String(category), sort, order: sort === 'discount' ? 'desc' : 'asc' },
        2,
        (row) => row.variant.id,
      );

      // on sale first (the biggest discount first, the soonest end first), the rest by the
      // popularity of the product, which they share, the newer variant first
      expect(ids.slice(0, 2)).toEqual([variants[1], variants[2]]);
      expect(ids.slice(2)).toEqual([variants[4], variants[3], variants[0]]);
    }
  });

  it('refuses the cursor of a list of products in a list of variants, and the other way round', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category);
    await createVariant(product.id, { price: 11 });
    await newProduct(category);

    // the same sort and direction, another kind of row
    const products = await list({ categoryIds: String(category), limit: '1' });
    const variants = await list({ categoryIds: String(category), minPrice: '0', limit: '1' });
    const productCursor = products.json().nextCursor as string;
    const variantCursor = variants.json().nextCursor as string;

    const productsInVariants = await list({
      categoryIds: String(category),
      minPrice: '0',
      limit: '1',
      cursor: productCursor,
    });
    const variantsInProducts = await list({
      categoryIds: String(category),
      limit: '1',
      cursor: variantCursor,
    });

    expect(productsInVariants.statusCode).toBe(400);
    expect(productsInVariants.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    expect(variantsInProducts.statusCode).toBe(400);
    expect(variantsInProducts.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });
});

describe('the number of the rows', () => {
  it('counts the rows the filters find, whatever the page', async () => {
    const category = (await createCategory()).id;
    const product = await newProduct(category);
    const second = await createVariant(product.id, { price: 11 });
    await keepApart([product.variantId, second.id]);
    await newProduct(category);
    await newProduct(category);

    const firstPage = await list({ categoryIds: String(category), limit: '1' });
    const lastPage = await list({ categoryIds: String(category), limit: '2' });
    const variantRows = await list({ categoryIds: String(category), limit: '1', minPrice: '0' });
    const empty = await list({ categoryIds: String(category), minPrice: '1000' });

    expect(firstPage.json().total).toBe(3);
    expect(lastPage.json().total).toBe(3);
    // four variants in three products
    expect(variantRows.json().total).toBe(4);
    expect(empty.json()).toMatchObject({ items: [], total: 0 });
  });

  it('counts the second page the same as the first', async () => {
    const category = (await createCategory()).id;
    for (let n = 0; n < 3; n += 1) await newProduct(category);

    const first = await list({ categoryIds: String(category), limit: '2' });
    const second = await list({
      categoryIds: String(category),
      limit: '2',
      cursor: first.json().nextCursor,
    });

    expect(first.json().total).toBe(3);
    expect(second.json().total).toBe(3);
    expect(second.json().items).toHaveLength(1);
    expect(second.json()).not.toHaveProperty('nextCursor');
  });
});

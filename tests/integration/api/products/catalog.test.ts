import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createFavorite,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  putOnSale,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';

// the catalog for a buyer and for an admin (GET /api/products, GET /api/products/:productId). A
// buyer (guest, user) sees what helps to buy: the price, the sale, the free units, the rating,
// the category; the list shows the popularity it sorts by, the card does not. An admin (admin,
// root) sees the counters, the whole stock, the reserve and the override of the popularity on
// top. An admin sorts by any field; a field only some products have (deleted, on sale, with an
// override that is on) comes with its flag: without any flag the list has only the plain products,
// a flag lists the products of its condition whatever else they have. A buyer sorts by the sale:
// the products on sale first by the end of the sale, the rest by popularity. A visit of an admin
// is no view of the product

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const DAY = 86_400_000;

async function newProduct(opts: { price?: number; stock?: number } = {}) {
  const product = await createProduct({ price: 10, stock: 5, ...opts });
  products.push(product);
  return product;
}

async function newUser(role: TestUser['role'] = 'USER') {
  const user = await createUser({ role });
  userIds.push(user.id);
  return user;
}

const headersOf = (actor?: TestUser) => (actor ? { cookie: accessCookie(actor) } : {});

const list = (query: Record<string, string>, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: `/api/products?${new URLSearchParams(query)}`,
    headers: headersOf(actor),
  });

const card = (productId: number, actor?: TestUser) =>
  app.inject({ method: 'GET', url: `/api/products/${productId}`, headers: headersOf(actor) });

const idsOf = (res: LightMyRequestResponse) =>
  (res.json().items as Array<{ id: number }>).map((item) => item.id);

const categoriesOf = (...of: TestProduct[]) => of.map((product) => product.categoryId).join(',');

// every page of a list, one product a page
async function pagesOf(query: Record<string, string>, actor?: TestUser) {
  const seen: number[] = [];
  let cursor: string | undefined;

  do {
    const res = await list({ ...query, limit: '1', ...(cursor ? { cursor } : {}) }, actor);
    expect(res.statusCode).toBe(200);
    seen.push(...idsOf(res));
    cursor = res.json().nextCursor;
  } while (cursor && seen.length < 20);

  return seen;
}

const setOverride = (productId: number, popularityOverride: number, until: Date | null) =>
  asAdmin((tx) =>
    tx.product.update({
      where: { id: productId },
      data: { popularityOverride, popularityOverrideUntil: until },
    }),
  );

const viewsOf = async (productId: number) =>
  (
    await asAdmin((tx) =>
      tx.product.findUniqueOrThrow({ where: { id: productId }, select: { views: true } }),
    )
  ).views;

const ADMIN_FIELDS = [
  'views',
  'updatedAt',
  'totalStock',
  'reservedStock',
  'popularityOverride',
  'popularityOverrideUntil',
  'deletedAt',
];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser('ADMIN');
  root = await newUser('ROOT');
});

// products with orders, favorites or logs stay: they leave the catalog
afterAll(async () => {
  try {
    for (const product of products) await deleteProductFromCatalog(product.id);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('the answers of a buyer and of an admin', () => {
  let product: TestProduct;
  let category: { id: number; name: string; slug: string };

  // five units, two of them reserved by an order that waits for its payment
  beforeAll(async () => {
    product = await newProduct({ stock: 5 });
    await placeOrder(app, csrf, await newUser(), product, 'waiting', 2);
    category = await asAdmin((tx) =>
      tx.category.findUniqueOrThrow({
        where: { id: product.categoryId },
        select: { id: true, name: true, slug: true },
      }),
    );
  });

  it.each([
    ['a guest', async () => undefined],
    ['a user', () => newUser()],
  ])(
    'gives %s the card without the popularity and the fields of an admin',
    async (_who, actorOf) => {
      const res = await card(product.id, await actorOf());

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: product.id, stock: 3, category });
      for (const field of ['popularity', 'categoryId', ...ADMIN_FIELDS]) {
        expect(res.json()).not.toHaveProperty(field);
      }
    },
  );

  it('gives a buyer the list with the popularity and no fields of an admin', async () => {
    const res = await list({ categoryIds: String(product.categoryId) });

    expect(res.statusCode).toBe(200);
    const [item] = res.json().items;
    expect(item).toMatchObject({
      id: product.id,
      stock: 3,
      category,
      popularity: expect.any(Number),
    });
    for (const field of ['categoryId', ...ADMIN_FIELDS]) expect(item).not.toHaveProperty(field);
  });

  it('gives the favorites of a buyer the fields of the list of a buyer', async () => {
    const user = await newUser();
    await createFavorite(user.id, product.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/favorites',
      headers: headersOf(user),
    });

    expect(res.statusCode).toBe(200);
    const [{ product: item }] = res.json().items;
    expect(item).toMatchObject({ id: product.id, category, popularity: expect.any(Number) });
    for (const field of ADMIN_FIELDS) expect(item).not.toHaveProperty(field);
  });

  it.each([
    ['an admin', () => admin],
    ['root', () => root],
  ])(
    'gives %s the card and the list with the counters and the whole stock',
    async (_who, actorOf) => {
      const shown = {
        id: product.id,
        category,
        stock: 3,
        totalStock: 5,
        reservedStock: 2,
        popularity: expect.any(Number),
        views: expect.any(Number),
        updatedAt: expect.any(String),
        popularityOverride: null,
        popularityOverrideUntil: null,
        salePrice: null,
        saleEndsAt: null,
        deletedAt: null,
      };

      const one = await card(product.id, actorOf());
      const many = await list({ categoryIds: String(product.categoryId) }, actorOf());

      expect(one.statusCode).toBe(200);
      expect(one.json()).toMatchObject(shown);
      expect(many.json().items).toEqual([expect.objectContaining(shown)]);
    },
  );

  it('answers a change of an admin with the card of an admin', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { description: 'Changed by the admin' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      category,
      totalStock: 5,
      reservedStock: 2,
      views: expect.any(Number),
    });
  });
});

describe('the views of a product', () => {
  it('counts the visit of a buyer and not the one of an admin or root', async () => {
    const product = await newProduct();
    const before = await viewsOf(product.id);

    await card(product.id, admin);
    await card(product.id, root);
    expect(await viewsOf(product.id)).toBe(before);

    await card(product.id);
    await card(product.id, await newUser());
    expect(await viewsOf(product.id)).toBe(before + 2);
  });
});

describe('the sorts and the flags of a buyer', () => {
  it.each([
    'views',
    'updatedAt',
    'stock',
    'reviewsCount',
    'salePrice',
    'totalStock',
    'reservedStock',
    'popularityOverride',
    'popularityOverrideUntil',
    'deletedAt',
  ])('refuses a sort by %s', async (sort) => {
    const res = await list({ sort });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'SORT_FORBIDDEN', details: { sort } });
  });

  // the products of the file only: other files delete theirs meanwhile
  it.each(['createdAt', 'price', 'popularity', 'avgRating', 'name', 'saleEndsAt'])(
    'sorts by %s',
    async (sort) => {
      const product = await newProduct();

      const res = await list(
        { sort, order: 'asc', categoryIds: String(product.categoryId) },
        await newUser(),
      );

      expect(res.statusCode).toBe(200);
      expect(idsOf(res)).toEqual([product.id]);
    },
  );

  it.each([
    ['onSale', 'FILTER_FORBIDDEN'],
    ['popularityOverridden', 'FILTER_FORBIDDEN'],
    ['deleted', 'DELETED_PRODUCTS_FORBIDDEN'],
  ])('refuses the flag %s of an admin', async (flag, errorCode) => {
    const res = await list({ [flag]: 'true' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode });
  });

  // a buyer sees every product of the catalog, the ones on sale too
  it('lists products on sale and with an override among the rest', async () => {
    const plain = await newProduct();
    const onSale = await newProduct();
    const overridden = await newProduct();
    await putOnSale(onSale.id, 5);
    await setOverride(overridden.id, 50, new Date(Date.now() + DAY));

    const res = await list({ categoryIds: categoriesOf(plain, onSale, overridden) });

    expect(idsOf(res).sort((a, b) => a - b)).toEqual(
      [plain.id, onSale.id, overridden.id].sort((a, b) => a - b),
    );
  });

  describe('by the sale', () => {
    let soon: TestProduct;
    let late: TestProduct;
    let popular: TestProduct;
    let quiet: TestProduct;
    let categoryIds: string;

    // two products on sale and two without, one of them in the favorites of two users
    beforeAll(async () => {
      [soon, late, popular, quiet] = [
        await newProduct(),
        await newProduct(),
        await newProduct(),
        await newProduct(),
      ];
      await putOnSale(soon.id, 5, DAY);
      await putOnSale(late.id, 5, 2 * DAY);
      for (let n = 0; n < 2; n++) await createFavorite((await newUser()).id, popular.id);
      categoryIds = categoriesOf(soon, late, popular, quiet);
    });

    it.each([
      ['asc', () => [soon.id, late.id, popular.id, quiet.id]],
      ['desc', () => [late.id, soon.id, popular.id, quiet.id]],
    ])(
      'gives the products on sale first going %s, then the rest by popularity',
      async (order, ids) => {
        const res = await list({ categoryIds, sort: 'saleEndsAt', order });

        expect(res.statusCode).toBe(200);
        expect(idsOf(res)).toEqual(ids());
      },
    );

    it('pages through both parts of the list', async () => {
      expect(await pagesOf({ categoryIds, sort: 'saleEndsAt', order: 'asc' })).toEqual([
        soon.id,
        late.id,
        popular.id,
        quiet.id,
      ]);
    });
  });
});

// without any flag an admin gets the plain products: not deleted, without a sale that is on and
// without an override that is on. With a flag only its condition counts, the other marks do not
// filter; the deleted products stay out without their flag. An override is on while its end is
// ahead: the database takes no override without an end and none past its end
describe('the flags and the sorts of an admin', () => {
  let plain: TestProduct;
  let overrideOver: TestProduct;
  let overrideWithoutEnd: TestProduct;
  let onSale: TestProduct;
  let overridden: TestProduct;
  let overriddenSoon: TestProduct;
  let onSaleOverridden: TestProduct;
  let deleted: TestProduct;
  let deletedOverridden: TestProduct;
  let categoryIds: string;

  beforeAll(async () => {
    [
      plain,
      overrideOver,
      overrideWithoutEnd,
      onSale,
      overridden,
      overriddenSoon,
      onSaleOverridden,
      deleted,
      deletedOverridden,
    ] = [
      await newProduct(),
      await newProduct(),
      await newProduct(),
      await newProduct(),
      await newProduct(),
      await newProduct(),
      await newProduct(),
      await newProduct(),
      await newProduct(),
    ];
    await setOverride(overrideOver.id, 70, new Date(Date.now() - DAY));
    await setOverride(overrideWithoutEnd.id, 30, null);
    await putOnSale(onSale.id, 5);
    await setOverride(overridden.id, 50, new Date(Date.now() + 5 * DAY));
    await setOverride(overriddenSoon.id, 10, new Date(Date.now() + 3 * DAY));
    await putOnSale(onSaleOverridden.id, 5);
    await setOverride(onSaleOverridden.id, 20, new Date(Date.now() + 4 * DAY));
    await deleteProductFromCatalog(deleted.id);
    await setOverride(deletedOverridden.id, 40, new Date(Date.now() + DAY));
    await deleteProductFromCatalog(deletedOverridden.id);
    categoryIds = categoriesOf(
      plain,
      overrideOver,
      overrideWithoutEnd,
      onSale,
      overridden,
      overriddenSoon,
      onSaleOverridden,
      deleted,
      deletedOverridden,
    );
  });

  const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

  // an override past its end or without one overrides nothing, the product is a plain one
  it('lists only the plain products when no flag is sent', async () => {
    const res = await list({ categoryIds }, admin);

    expect(res.statusCode).toBe(200);
    expect(sorted(idsOf(res))).toEqual(sorted([plain.id, overrideOver.id, overrideWithoutEnd.id]));
  });

  it.each([
    ['onSale', () => [onSale.id, onSaleOverridden.id]],
    ['popularityOverridden', () => [overridden.id, overriddenSoon.id, onSaleOverridden.id]],
    ['deleted', () => [deleted.id, deletedOverridden.id]],
  ])('lists every product of the flag %s, whatever else it has', async (flag, ids) => {
    const res = await list({ categoryIds, [flag]: 'true' }, admin);

    expect(res.statusCode).toBe(200);
    expect(sorted(idsOf(res))).toEqual(sorted(ids()));
  });

  it('lists the products of every flag sent', async () => {
    const res = await list({ categoryIds, onSale: 'true', popularityOverridden: 'true' }, admin);

    expect(idsOf(res)).toEqual([onSaleOverridden.id]);
  });

  it('lets root use the flags', async () => {
    const res = await list({ categoryIds, onSale: 'true' }, root);

    expect(sorted(idsOf(res))).toEqual(sorted([onSale.id, onSaleOverridden.id]));
  });

  it.each([
    ['saleEndsAt', 'SORT_SALE_ENDS_AT_REQUIRES_ON_SALE'],
    ['popularityOverride', 'SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN'],
    ['popularityOverrideUntil', 'SORT_POPULARITY_OVERRIDE_REQUIRES_OVERRIDDEN'],
    ['deletedAt', 'SORT_DELETED_AT_REQUIRES_DELETED'],
  ])('sorts by %s only with its flag', async (sort, errorCode) => {
    const res = await list({ categoryIds, sort }, admin);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
  });

  it('sorts the products of a flag by another field as well', async () => {
    const res = await list({ categoryIds, onSale: 'true', sort: 'price', order: 'asc' }, admin);

    expect(res.statusCode).toBe(200);
    expect(sorted(idsOf(res))).toEqual(sorted([onSale.id, onSaleOverridden.id]));
  });

  it('sorts the overrides by their value', async () => {
    const res = await list(
      { categoryIds, popularityOverridden: 'true', sort: 'popularityOverride', order: 'desc' },
      admin,
    );

    expect(idsOf(res)).toEqual([overridden.id, onSaleOverridden.id, overriddenSoon.id]);
  });

  it.each([
    ['asc', () => [overriddenSoon.id, onSaleOverridden.id, overridden.id]],
    ['desc', () => [overridden.id, onSaleOverridden.id, overriddenSoon.id]],
  ])('sorts the overrides by their end going %s, page by page too', async (order, ids) => {
    const query = {
      categoryIds,
      popularityOverridden: 'true',
      sort: 'popularityOverrideUntil',
      order,
    };

    expect(idsOf(await list(query, admin))).toEqual(ids());
    expect(await pagesOf(query, admin)).toEqual(ids());
  });

  describe('by the stock', () => {
    let mostlyReserved: TestProduct;
    let free: TestProduct;

    // five units with four reserved (one free), and three units with none reserved
    beforeAll(async () => {
      mostlyReserved = await newProduct({ stock: 5 });
      free = await newProduct({ stock: 3 });
      await placeOrder(app, csrf, await newUser(), mostlyReserved, 'waiting', 4);
    });

    it.each([
      ['the free units', 'stock', 'asc', () => [mostlyReserved.id, free.id]],
      ['the whole stock', 'totalStock', 'asc', () => [free.id, mostlyReserved.id]],
      ['the reserve', 'reservedStock', 'desc', () => [mostlyReserved.id, free.id]],
    ])('sorts by %s', async (_case, sort, order, ids) => {
      const res = await list(
        { categoryIds: categoriesOf(mostlyReserved, free), sort, order },
        admin,
      );

      expect(res.statusCode).toBe(200);
      expect(idsOf(res)).toEqual(ids());
    });
  });
});

// an admin sees two prices, the usual one and the sale price: a price sort and the price filters
// take the usual price the field shows, the sale price has a sort of its own in the list of the
// products on sale. A buyer sorts and filters by the price a product sells at now
describe('the prices of an admin', () => {
  let deepSale: TestProduct;
  let smallSale: TestProduct;
  let categoryIds: string;

  // 30 on sale for 5, and 20 on sale for 15
  beforeAll(async () => {
    deepSale = await newProduct({ price: 30 });
    smallSale = await newProduct({ price: 20 });
    await putOnSale(deepSale.id, 5);
    await putOnSale(smallSale.id, 15);
    categoryIds = categoriesOf(deepSale, smallSale);
  });

  it('shows an admin both prices of a product on sale', async () => {
    const res = await list({ categoryIds, onSale: 'true' }, admin);

    expect(res.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: deepSale.id, price: 30, salePrice: 5 }),
        expect.objectContaining({ id: smallSale.id, price: 20, salePrice: 15 }),
      ]),
    );
  });

  it.each([
    ['the usual price', 'price', () => [smallSale.id, deepSale.id]],
    ['the sale price', 'salePrice', () => [deepSale.id, smallSale.id]],
  ])('sorts the products on sale by %s', async (_case, sort, ids) => {
    const query = { categoryIds, onSale: 'true', sort, order: 'asc' };

    expect(idsOf(await list(query, admin))).toEqual(ids());
    expect(await pagesOf(query, admin)).toEqual(ids());
  });

  it('sorts by the sale price only with onSale', async () => {
    const res = await list({ categoryIds, sort: 'salePrice' }, admin);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SORT_SALE_PRICE_REQUIRES_ON_SALE' });
  });

  it('filters the prices of an admin by the usual price', async () => {
    const res = await list({ categoryIds, onSale: 'true', maxPrice: '25' }, admin);

    expect(idsOf(res)).toEqual([smallSale.id]);
  });

  it('sorts and filters the prices of a buyer by the price a product sells at', async () => {
    const sorted = await list({ categoryIds, sort: 'price', order: 'asc' });
    const cheap = await list({ categoryIds, maxPrice: '10' });

    expect(idsOf(sorted)).toEqual([deepSale.id, smallSale.id]);
    expect(idsOf(cheap)).toEqual([deepSale.id]);
  });
});

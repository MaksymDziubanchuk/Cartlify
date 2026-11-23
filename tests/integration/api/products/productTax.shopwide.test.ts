import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';

// The tax group of a product and the countries that class it in another group (docs/taxes.md): an
// admin writes them with the product (PATCH /api/products/:productId), reads them on the card of an
// admin, and changes them for many products at once (PATCH /api/products/tax), a dry run listing the
// products of the scope. *.shopwide.test.ts: the groups are of the whole shop; the file removes the
// ones it made

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let books: number;
let food: number;
let first: TestProduct;
let second: TestProduct;

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  actor = admin,
) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    ...(payload ? { payload } : {}),
  });

// a group with a rate in every country that has rates now
async function makeGroup(name: string): Promise<number> {
  const countries = (await call('GET', '/api/root/countries', undefined, root)).json().items as {
    country: string;
    rates: unknown[];
  }[];
  const rates = Object.fromEntries(
    countries.filter((c) => c.rates.length > 0).map((c) => [c.country, 10]),
  );
  const res = await call('POST', '/api/root/tax-groups', { name, rates }, root);
  return res.json().id;
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  books = await makeGroup('Books of the product test');
  food = await makeGroup('Food of the product test');
  first = await createProduct();
  second = await createProduct();
});

afterAll(async () => {
  try {
    await call('PATCH', '/api/products/tax', {
      scope: { productIds: [first.id, second.id] },
      taxGroupId: null,
      removeExceptions: ['DE', 'FR', 'PL'],
    });
    for (const id of [books, food])
      await call('DELETE', `/api/root/tax-groups/${id}`, undefined, root);
    await closeSessions([admin.id, root.id]);
  } finally {
    await stopApp();
  }
});

describe('the group and the classes of one product', () => {
  it('writes them with the product and shows them on the card of an admin only', async () => {
    const res = await call('PATCH', `/api/products/${first.id}`, {
      taxGroupId: books,
      taxExceptions: { DE: null, FR: food },
    });
    const card = (await call('GET', `/api/products/${first.id}`)).json().product;
    const visitor = (await app.inject({ method: 'GET', url: `/api/products/${first.id}` })).json()
      .product;

    expect(res.statusCode).toBe(200);
    expect(card).toMatchObject({ taxGroupId: books, taxExceptions: { DE: null, FR: food } });
    expect(visitor).not.toHaveProperty('taxGroupId');
    expect(visitor).not.toHaveProperty('taxExceptions');
  });

  it('refuses a group that is not there and classes that are no such object', async () => {
    const group = await call('PATCH', `/api/products/${first.id}`, { taxGroupId: 999_999_999 });
    const classes = await call('PATCH', `/api/products/${first.id}`, { taxExceptions: { de: 1 } });

    expect(group.json()).toMatchObject({
      errorCode: 'TAX_GROUP_NOT_FOUND',
      details: { groupIds: [999_999_999] },
    });
    expect(classes.statusCode).toBe(400);
  });
});

describe('PATCH /api/products/tax', () => {
  it('lists the products of the scope in a dry run and writes nothing', async () => {
    const res = await call('PATCH', '/api/products/tax', {
      scope: { productIds: [first.id, second.id], exceptionOf: 'FR' },
      exceptions: { PL: food },
      dryRun: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      dryRun: true,
      count: 1,
      products: [{ id: first.id, taxExceptions: { DE: null, FR: food, PL: food } }],
    });
    const card = (await call('GET', `/api/products/${first.id}`)).json().product;
    expect(card.taxExceptions).toEqual({ DE: null, FR: food });
  });

  it('gives the group and the classes to every product of the scope and takes the ones named', async () => {
    const res = await call('PATCH', '/api/products/tax', {
      scope: { productIds: [first.id, second.id] },
      taxGroupId: food,
      exceptions: { PL: books },
      removeExceptions: ['DE'],
    });

    expect(res.json()).toMatchObject({ dryRun: false, count: 2 });
    const one = (await call('GET', `/api/products/${first.id}`)).json().product;
    const two = (await call('GET', `/api/products/${second.id}`)).json().product;
    expect(one).toMatchObject({ taxGroupId: food, taxExceptions: { FR: food, PL: books } });
    expect(two).toMatchObject({ taxGroupId: food, taxExceptions: { PL: books } });
  });

  it('refuses a country given a class and losing it at once', async () => {
    const res = await call('PATCH', '/api/products/tax', {
      scope: { productIds: [first.id] },
      exceptions: { PL: books },
      removeExceptions: ['PL'],
    });

    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_TAX_EXCEPTION_TWICE',
      details: { countries: ['PL'] },
    });
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import {
  choose,
  createChoice,
  createProductWith,
  numberOf,
  type TestChoice,
} from '../../../helpers/characteristics.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
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
import { markVariantDeleted, priceRowOf } from '../../../helpers/variants.js';

// PATCH /api/products with `scope.f`: the change of the prices takes the variants that have the
// characteristics asked, the way the filter of the catalog (`f`) reads them: a text or a list of
// texts `<attributeId>:<value>`, the values of one characteristic OR, different ones AND, a number a
// range with both ends included, yes/no. A dry run lists the variants it would change

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const products: TestProduct[] = [];

let colour: TestChoice;
let memory: TestAttribute;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  colour = await createChoice(['black', 'white']);
  memory = await createAttribute({ type: 'number' });
});

afterAll(async () => {
  try {
    for (const product of products) await deleteProductFromCatalog(product.id);
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

const bulk = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: '/api/products',
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

const priceOf = async (variantId: number) => (await priceRowOf(variantId)).price;

async function shelf() {
  const category = (await createCategory()).id;
  const made = await createProductWith(category, [
    { price: 10, values: [choose(colour, 'black'), numberOf(memory, 64)] },
    { price: 20, values: [choose(colour, 'black'), numberOf(memory, 128)] },
    { price: 30, values: [choose(colour, 'white'), numberOf(memory, 128)] },
    { price: 40 },
  ]);
  products.push(made.product);

  return { category, variantIds: made.variantIds };
}

const black = () => `${colour.attribute.id}:${colour.option.black}`;

describe('PATCH /api/products with scope.f', () => {
  it('lists the variants that have the characteristic in a dry run', async () => {
    const { category, variantIds } = await shelf();

    const res = await bulk({
      mode: 'fixed',
      value: 5,
      dryRun: true,
      scope: { categoryId: category, f: [black()] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      updatedCount: number;
      variants: { id: number; oldPrice: number; newPrice: number }[];
    };
    expect(body.updatedCount).toBe(2);
    expect(body.variants.map((v) => [v.id, v.oldPrice, v.newPrice])).toEqual([
      [variantIds[0], 10, 15],
      [variantIds[1], 20, 25],
    ]);
    // a dry run changes nothing
    expect(await priceOf(variantIds[0]!)).toBe(10);
  });

  it('changes the prices of those variants only', async () => {
    const { category, variantIds } = await shelf();

    const res = await bulk({
      mode: 'percent',
      value: 10,
      scope: { categoryId: category, f: [black()] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'PRODUCTS_PRICE_BULK_UPDATED', updatedCount: 2 });
    expect(await Promise.all(variantIds.map(priceOf))).toEqual([11, 22, 30, 40]);
  });

  it('takes one text as well as a list', async () => {
    const { category, variantIds } = await shelf();

    const res = await bulk({
      mode: 'fixed',
      value: 1,
      dryRun: true,
      scope: { categoryId: category, f: `${memory.id}:100..` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants.map((v: { id: number }) => v.id)).toEqual([
      variantIds[1],
      variantIds[2],
    ]);
  });

  it('keeps the values of one characteristic OR and different characteristics AND', async () => {
    const { category, variantIds } = await shelf();

    const orAnd = await bulk({
      mode: 'fixed',
      value: 1,
      dryRun: true,
      scope: {
        categoryId: category,
        f: [
          `${colour.attribute.id}:${colour.option.black},${colour.option.white}`,
          `${memory.id}:100..`,
        ],
      },
    });

    expect(orAnd.json().variants.map((v: { id: number }) => v.id)).toEqual([
      variantIds[1],
      variantIds[2],
    ]);
  });

  it('goes with the other parts of the scope', async () => {
    const { category, variantIds } = await shelf();

    const res = await bulk({
      mode: 'fixed',
      value: 1,
      dryRun: true,
      scope: { categoryId: category, f: [black()], minPrice: 15 },
    });

    expect(res.json().variants.map((v: { id: number }) => v.id)).toEqual([variantIds[1]]);
  });

  it('leaves out a variant that is taken out of sale, as without the filter', async () => {
    const { category, variantIds } = await shelf();
    await markVariantDeleted(variantIds[1]!);

    const res = await bulk({
      mode: 'fixed',
      value: 1,
      dryRun: true,
      scope: { categoryId: category, f: [black()] },
    });

    expect(res.json().variants.map((v: { id: number }) => v.id)).toEqual([variantIds[0]]);
  });

  it('finds no variant when none has the value', async () => {
    const { category } = await shelf();

    const res = await bulk({
      mode: 'fixed',
      value: 1,
      dryRun: true,
      scope: { categoryId: category, f: [`${memory.id}:1000..`] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updatedCount: 0, variants: [] });
  });

  it('refuses a filter that is wrong the way the catalog does, and changes nothing', async () => {
    const { category, variantIds } = await shelf();

    const unknown = await bulk({
      mode: 'fixed',
      value: 1,
      scope: { categoryId: category, f: ['2147483647:1'] },
    });
    const form = await bulk({
      mode: 'fixed',
      value: 1,
      scope: { categoryId: category, f: [`${memory.id}:5`] },
    });
    const syntax = await bulk({ mode: 'fixed', value: 1, scope: { categoryId: category, f: 'x' } });

    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({
      errorCode: 'FILTER_INVALID',
      details: { reason: 'ATTRIBUTE_NOT_FOUND', index: 0 },
    });
    expect(form.json()).toMatchObject({
      errorCode: 'FILTER_INVALID',
      details: { reason: 'VALUE_FORM_MISMATCH', type: 'number' },
    });
    expect(syntax.json()).toMatchObject({
      errorCode: 'FILTER_INVALID',
      details: { reason: 'ENTRY_INVALID' },
    });
    expect(await Promise.all(variantIds.map(priceOf))).toEqual([10, 20, 30, 40]);
  });

  it('refuses an f that is neither a text nor a list of texts', async () => {
    const { category } = await shelf();

    const res = await bulk({
      mode: 'fixed',
      value: 1,
      scope: { categoryId: category, f: { memory: 5 } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

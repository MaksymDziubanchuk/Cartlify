import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { multipartBody } from '../../../helpers/multipart.js';

// the popularity an admin sets (PATCH /api/products/:productId, popularityOverride and
// popularityOverrideUntil): the database takes it while its end is ahead, an override without an
// end overrides nothing. So a product has an override with its end, or neither: a change of one
// of them keeps the other one of the product, the end of a new override is in the future

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const DAY = 86_400_000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

async function newProduct() {
  const product = await createProduct();
  products.push(product);
  return product;
}

const patchJson = (productId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

const patchForm = (productId: number, fields: Record<string, string>) => {
  const { payload, headers } = multipartBody(
    Object.entries(fields).map(([name, value]) => ({ name, value })),
  );
  return app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
    headers: { ...withCsrf(csrf, accessCookie(admin)), ...headers },
    payload,
  });
};

const overrideOf = async (productId: number) => {
  const row = await asAdmin((tx) =>
    tx.product.findUniqueOrThrow({
      where: { id: productId },
      select: { popularity: true, popularityOverride: true, popularityOverrideUntil: true },
    }),
  );
  return {
    popularity: row.popularity,
    popularityOverride: row.popularityOverride,
    popularityOverrideUntil: row.popularityOverrideUntil?.toISOString() ?? null,
  };
};

// a product with an override that is on
async function overriddenProduct(value = 500, until = inMs(DAY)) {
  const product = await newProduct();
  const res = await patchJson(product.id, {
    popularityOverride: value,
    popularityOverrideUntil: until,
  });
  if (res.statusCode !== 200) throw new Error(`setting the override answered ${res.statusCode}`);
  return product;
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
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

describe('PATCH /api/products/:productId and the popularity override', () => {
  // the popularity itself follows with the next event of the product (it.failing in db/catalog)
  it('sets an override with its end', async () => {
    const product = await newProduct();
    const until = inMs(DAY);

    const res = await patchJson(product.id, {
      popularityOverride: 500,
      popularityOverrideUntil: until,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ popularityOverride: 500, popularityOverrideUntil: until });
    expect(await overrideOf(product.id)).toMatchObject({
      popularityOverride: 500,
      popularityOverrideUntil: until,
    });
  });

  it.each([
    [
      'an override without an end',
      { popularityOverride: 500 },
      'POPULARITY_OVERRIDE_UNTIL_REQUIRED',
    ],
    [
      'an end without an override',
      { popularityOverrideUntil: inMs(DAY) },
      'POPULARITY_OVERRIDE_REQUIRED',
    ],
    [
      'an override with an end in the past',
      { popularityOverride: 500, popularityOverrideUntil: inMs(-DAY) },
      'POPULARITY_OVERRIDE_UNTIL_INVALID',
    ],
  ])('refuses %s and changes nothing', async (_case, payload, errorCode) => {
    const product = await newProduct();
    const before = await overrideOf(product.id);

    const res = await patchJson(product.id, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect(await overrideOf(product.id)).toEqual(before);
  });

  it('changes only the end of an override that is on', async () => {
    const product = await overriddenProduct(500);
    const until = inMs(2 * DAY);

    const res = await patchJson(product.id, { popularityOverrideUntil: until });

    expect(res.statusCode).toBe(200);
    expect(await overrideOf(product.id)).toMatchObject({
      popularityOverride: 500,
      popularityOverrideUntil: until,
    });
  });

  it('changes only the value of an override that has its end', async () => {
    const until = inMs(DAY);
    const product = await overriddenProduct(500, until);

    const res = await patchJson(product.id, { popularityOverride: 700 });

    expect(res.statusCode).toBe(200);
    expect(await overrideOf(product.id)).toMatchObject({
      popularityOverride: 700,
      popularityOverrideUntil: until,
    });
  });

  it.each([
    ['the override and keep its end', { popularityOverride: null }, 'POPULARITY_OVERRIDE_REQUIRED'],
    [
      'the end and keep the override',
      { popularityOverrideUntil: null },
      'POPULARITY_OVERRIDE_UNTIL_REQUIRED',
    ],
  ])('refuses to take off %s', async (_case, payload, errorCode) => {
    const product = await overriddenProduct();
    const before = await overrideOf(product.id);

    const res = await patchJson(product.id, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect(await overrideOf(product.id)).toEqual(before);
  });

  it('takes off the override with its end', async () => {
    const product = await overriddenProduct();

    const res = await patchJson(product.id, {
      popularityOverride: null,
      popularityOverrideUntil: null,
    });

    expect(res.statusCode).toBe(200);
    expect(await overrideOf(product.id)).toMatchObject({
      popularityOverride: null,
      popularityOverrideUntil: null,
    });
  });

  // a change that does not touch the override is not checked: dev keeps old rows with an override
  // and no end
  it('changes another field of a product that has an override without an end', async () => {
    const product = await newProduct();
    await asAdmin((tx) =>
      tx.product.update({ where: { id: product.id }, data: { popularityOverride: 30 } }),
    );

    const res = await patchJson(product.id, { name: 'Renamed with an old override' });

    expect(res.statusCode).toBe(200);
  });

  describe('in a form', () => {
    it('refuses an override without an end', async () => {
      const product = await newProduct();

      const res = await patchForm(product.id, { popularityOverride: '500' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'POPULARITY_OVERRIDE_UNTIL_REQUIRED' });
    });

    it('sets an override with its end', async () => {
      const product = await newProduct();
      const until = inMs(DAY);

      const res = await patchForm(product.id, {
        popularityOverride: '500',
        popularityOverrideUntil: until,
      });

      expect(res.statusCode).toBe(200);
      expect(await overrideOf(product.id)).toMatchObject({
        popularityOverride: 500,
        popularityOverrideUntil: until,
      });
    });

    // an empty field takes the value off, the other one has to go too
    it('takes off the override with its end by two empty fields', async () => {
      const product = await overriddenProduct();

      const res = await patchForm(product.id, {
        popularityOverride: '',
        popularityOverrideUntil: '',
      });

      expect(res.statusCode).toBe(200);
      expect(await overrideOf(product.id)).toMatchObject({
        popularityOverride: null,
        popularityOverrideUntil: null,
      });
    });
  });
});

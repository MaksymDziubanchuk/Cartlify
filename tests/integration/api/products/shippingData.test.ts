import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { removeUploads } from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  createVariant,
  type TestUser,
} from '../../../helpers/factories.js';
import { createProductForm } from '../../../helpers/productForm.js';
import { auditLinesOf } from '../../../helpers/variants.js';

// what a variant weighs and measures packed, the way it is sent (grams and millimetres): the
// shipping needs it whatever the method, the buyer sees it on the card, the admin in the list too. A
// new variant has it unless the admin says it comes later (a flag that is not kept); the three
// sizes come together or not at all; clearing what is known needs the flag too

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
// the category of the products the form makes
let categoryId: number;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
  userIds.push(admin.id, buyer.id);
  ({ id: categoryId } = await createCategory());
});

afterAll(async () => {
  try {
    await removeUploads();
    await asAdmin(async (tx) => {
      await tx.product.deleteMany({ where: { categoryId } });
      await tx.category.deleteMany({ where: { id: categoryId } });
    });
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// a word of random letters for a search: the search forgives a typo, so words made of a counter
// would find each other
const word = () =>
  Array.from(randomBytes(10), (byte) => String.fromCharCode(97 + (byte % 26))).join('');

const SIZES = { lengthMm: 200, widthMm: 100, heightMm: 50 };

// a new product with one variant that has a price, a picture and what is given of its weight and
// sizes
const create = (shipping: Record<string, unknown>) =>
  createProductForm(app, csrf, admin, {
    categoryId,
    variants: [{ price: 10, images: [{ file: 0, position: 1 }], ...shipping }],
  });

const problemsOf = (res: { json: () => { details?: { variants?: unknown[] } } }) =>
  res.json().details?.variants;

const patch = (productId: number, variantId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/variants/${variantId}`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

const cardAs = async (actor: TestUser | null, productId: number) =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/products/${productId}`,
      ...(actor ? { headers: { cookie: accessCookie(actor) } } : {}),
    })
  ).json();

const rowOf = (variantId: number) =>
  asAdmin((tx) => tx.productVariant.findUniqueOrThrow({ where: { id: variantId } }));

describe('POST /api/products and the weight and the sizes of its variants', () => {
  it('creates a product with a variant with its weight and its three sizes, and the card shows them', async () => {
    const res = await create({ weightGrams: 350, ...SIZES });

    expect(res.statusCode).toBe(201);
    const shown = { weightGrams: 350, lengthMm: 200, widthMm: 100, heightMm: 50 };
    expect(res.json().variant).toMatchObject(shown);
    expect((await cardAs(null, res.json().product.id)).variant).toMatchObject(shown);
    expect(await rowOf(res.json().variant.id)).toMatchObject(shown);
  });

  it('refuses a variant without them and names what is missing', async () => {
    const res = await create({});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
    expect(problemsOf(res)).toEqual([
      {
        index: 0,
        errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
        details: { fields: ['weightGrams', 'sizesMm'] },
      },
    ]);
  });

  it.each([
    ['the sizes', { weightGrams: 350 }, ['sizesMm']],
    ['the weight', SIZES, ['weightGrams']],
  ])('refuses a variant without %s and names it', async (_case, shipping, fields) => {
    const res = await create(shipping);

    expect(res.statusCode).toBe(400);
    expect(problemsOf(res)).toEqual([
      {
        index: 0,
        errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
        details: { fields },
      },
    ]);
  });

  it('creates a variant without them when the admin says they come later', async () => {
    const res = await create({ withoutShippingData: true });

    expect(res.statusCode).toBe(201);
    expect(res.json().variant).toMatchObject({
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
    // the flag is not kept: the empty fields say it
    expect(res.json().variant).not.toHaveProperty('withoutShippingData');
  });

  it('creates a variant with a weight and no sizes when the admin says the sizes come later', async () => {
    const res = await create({ weightGrams: 350, withoutShippingData: true });

    expect(res.statusCode).toBe(201);
    expect(res.json().variant).toMatchObject({ weightGrams: 350, lengthMm: null });
  });

  it('takes the flag with all the data given, and false as no flag', async () => {
    const full = await create({ weightGrams: 350, ...SIZES, withoutShippingData: true });
    const refused = await create({ withoutShippingData: false });

    expect(full.statusCode).toBe(201);
    expect(full.json().variant).toMatchObject({ weightGrams: 350, lengthMm: 200 });
    expect(refused.statusCode).toBe(400);
    expect(problemsOf(refused)).toEqual([
      expect.objectContaining({ errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED' }),
    ]);
  });

  it('refuses a flag that is not true or false', async () => {
    const res = await create({ withoutShippingData: 'yes' });

    expect(res.statusCode).toBe(400);
    expect(problemsOf(res)).toEqual([
      expect.objectContaining({ errorCode: 'PRODUCT_WITHOUT_SHIPPING_DATA_INVALID' }),
    ]);
  });

  it.each([
    ['one size alone', { lengthMm: 200 }],
    ['two sizes', { lengthMm: 200, widthMm: 100 }],
  ])('refuses %s, with the flag too: the sizes come all three or none', async (_case, sizes) => {
    const res = await create({ weightGrams: 350, withoutShippingData: true, ...sizes });

    expect(res.statusCode).toBe(400);
    expect(problemsOf(res)).toEqual([
      expect.objectContaining({ errorCode: 'PRODUCT_SIZES_INCOMPLETE' }),
    ]);
  });

  it.each([0, -5, 1.5, 'abc', 1_000_001])('refuses the weight %p', async (weightGrams) => {
    const res = await create({ weightGrams, ...SIZES });

    expect(res.statusCode).toBe(400);
    expect(problemsOf(res)).toEqual([
      expect.objectContaining({ errorCode: 'PRODUCT_WEIGHT_INVALID' }),
    ]);
  });

  it.each([0, -5, 1.5, 'abc', 10_001])('refuses the size %p', async (lengthMm) => {
    const res = await create({ weightGrams: 350, ...SIZES, lengthMm });

    expect(res.statusCode).toBe(400);
    expect(problemsOf(res)).toEqual([
      expect.objectContaining({ errorCode: 'PRODUCT_SIZES_INVALID' }),
    ]);
  });

  it('takes a ton and ten metres', async () => {
    const res = await create({
      weightGrams: 1_000_000,
      lengthMm: 10_000,
      widthMm: 10_000,
      heightMm: 10_000,
    });

    expect(res.statusCode).toBe(201);
  });

  it('writes the weight and the sizes to the admin log with the new variant', async () => {
    const res = await create({ weightGrams: 350, ...SIZES });

    const [line] = await auditLinesOf('variant', res.json().variant.id);
    expect(line!.event).toBe('variant.create');
    expect(line!.meta).toEqual(
      expect.arrayContaining([
        { field: 'weightGrams', old: null, new: 350 },
        { field: 'lengthMm', old: null, new: 200 },
        { field: 'widthMm', old: null, new: 100 },
        { field: 'heightMm', old: null, new: 50 },
      ]),
    );
  });

  it('names the variant that lacks them among the ones that have them', async () => {
    const res = await createProductForm(app, csrf, admin, {
      categoryId,
      files: 2,
      variants: [
        { price: 1, weightGrams: 10, ...SIZES, images: [{ file: 0, position: 1 }] },
        { price: 2, images: [{ file: 1, position: 1 }] },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(problemsOf(res)).toEqual([
      expect.objectContaining({ index: 1, errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED' }),
    ]);
  });
});

describe('PATCH /api/products/:productId/variants/:variantId and the weight and the sizes', () => {
  it('writes the data of a variant that has none', async () => {
    const product = await createProduct({ price: 10 });

    const res = await patch(product.id, product.variantId, {
      weightGrams: 350,
      lengthMm: 200,
      widthMm: 100,
      heightMm: 50,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({
      weightGrams: 350,
      lengthMm: 200,
      widthMm: 100,
      heightMm: 50,
    });
    expect(await rowOf(product.variantId)).toMatchObject({ weightGrams: 350, heightMm: 50 });
  });

  it('changes one size when the other two are there', async () => {
    const product = await createProduct({
      price: 10,
      weightGrams: 350,
      sizesMm: { length: 200, width: 100, height: 50 },
    });

    const res = await patch(product.id, product.variantId, { widthMm: 120 });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ lengthMm: 200, widthMm: 120, heightMm: 50 });
  });

  it('refuses one size for a variant that has none', async () => {
    const product = await createProduct({ price: 10 });

    const res = await patch(product.id, product.variantId, { lengthMm: 200 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SIZES_INCOMPLETE' });
    expect((await rowOf(product.variantId)).lengthMm).toBeNull();
  });

  it('changes another field of a variant that has no data without asking for them', async () => {
    const product = await createProduct({ price: 10 });

    const res = await patch(product.id, product.variantId, { sku: `NODATA-${word()}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ weightGrams: null });
  });

  it('changes the price of a variant that has no data without asking for them', async () => {
    const product = await createProduct({ price: 10 });

    const res = await patch(product.id, product.variantId, { price: 12 });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 12, weightGrams: null });
  });

  it('clears the data only when the admin says so', async () => {
    const product = await createProduct({
      price: 10,
      weightGrams: 350,
      sizesMm: { length: 200, width: 100, height: 50 },
    });

    const refused = await patch(product.id, product.variantId, { weightGrams: null });
    const refusedSizes = await patch(product.id, product.variantId, {
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
    const cleared = await patch(product.id, product.variantId, {
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      withoutShippingData: true,
    });

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED' });
    expect(refusedSizes.statusCode).toBe(400);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().variant).toMatchObject({
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
  });

  it('refuses to clear one size alone, with the flag too', async () => {
    const product = await createProduct({
      price: 10,
      weightGrams: 350,
      sizesMm: { length: 200, width: 100, height: 50 },
    });

    const res = await patch(product.id, product.variantId, {
      heightMm: null,
      withoutShippingData: true,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SIZES_INCOMPLETE' });
  });

  it.each([
    ['a weight of zero', { weightGrams: 0 }, 'PRODUCT_WEIGHT_INVALID'],
    ['a weight over a ton', { weightGrams: 1_000_001 }, 'PRODUCT_WEIGHT_INVALID'],
    ['a weight with a fraction', { weightGrams: 1.5 }, 'VALIDATION_ERROR'],
    ['a size of zero', { lengthMm: 0, widthMm: 10, heightMm: 10 }, 'PRODUCT_SIZES_INVALID'],
    [
      'a size over ten metres',
      { lengthMm: 10_001, widthMm: 10, heightMm: 10 },
      'PRODUCT_SIZES_INVALID',
    ],
  ])('refuses %s', async (_case, payload, errorCode) => {
    const product = await createProduct({ price: 10 });

    const res = await patch(product.id, product.variantId, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
  });

  it('writes the change to the admin log of the variant with the old and the new value', async () => {
    const product = await createProduct({ price: 10, weightGrams: 350 });

    await patch(product.id, product.variantId, {
      weightGrams: 400,
      lengthMm: 200,
      widthMm: 100,
      heightMm: 50,
    });

    const lines = await auditLinesOf('variant', product.variantId, ['variant.update']);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.meta).toEqual(
      expect.arrayContaining([
        { field: 'weightGrams', old: 350, new: 400 },
        { field: 'lengthMm', old: null, new: 200 },
      ]),
    );
  });
});

describe('the weight and the sizes of many variants at once', () => {
  const batch = (items: Array<Record<string, unknown>>) =>
    app.inject({
      method: 'PATCH',
      url: '/api/products/variants/batch',
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { items },
    });

  it('changes the data of many variants at once through the batch', async () => {
    const first = await createProduct({ price: 10 });
    const second = await createProduct({ price: 10 });

    const res = await batch([
      { variantId: first.variantId, weightGrams: 100, lengthMm: 10, widthMm: 10, heightMm: 10 },
      { variantId: second.variantId, weightGrams: 200 },
    ]);

    expect(res.statusCode).toBe(200);
    expect(await rowOf(first.variantId)).toMatchObject({ weightGrams: 100, lengthMm: 10 });
    expect(await rowOf(second.variantId)).toMatchObject({ weightGrams: 200, lengthMm: null });
  });

  it('names the variant a size is missing for and changes none', async () => {
    const first = await createProduct({ price: 10 });
    const second = await createProduct({ price: 10 });

    const res = await batch([
      { variantId: first.variantId, weightGrams: 100 },
      { variantId: second.variantId, lengthMm: 10 },
    ]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANTS_INVALID',
      details: {
        variants: [{ variantId: second.variantId, errorCode: 'PRODUCT_SIZES_INCOMPLETE' }],
      },
    });
    expect((await rowOf(first.variantId)).weightGrams).toBeNull();
  });

  it('changes the data of the variants of a product the same way', async () => {
    const product = await createProduct({ price: 10 });
    const other = await createVariant(product.id, { price: 12 });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}/variants`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { weightGrams: 350, lengthMm: 200, widthMm: 100, heightMm: 50 },
    });

    expect(res.statusCode).toBe(200);
    for (const id of [product.variantId, other.id]) {
      expect(await rowOf(id)).toMatchObject({ weightGrams: 350, lengthMm: 200, heightMm: 50 });
    }
  });
});

describe('who sees the weight and the sizes of a variant', () => {
  async function productWithData() {
    const tag = word();
    const product = await createProduct({
      price: 10,
      name: `Weighed ${tag}`,
      weightGrams: 350,
      sizesMm: { length: 200, width: 100, height: 50 },
    });
    return { product, tag };
  }

  it('gives the card of a product to everybody with the data, null where there are none', async () => {
    const { product } = await productWithData();
    const bare = await createProduct({ price: 10 });

    for (const actor of [null, buyer, admin]) {
      expect((await cardAs(actor, product.id)).variant).toMatchObject({
        weightGrams: 350,
        lengthMm: 200,
        widthMm: 100,
        heightMm: 50,
      });
      expect((await cardAs(actor, bare.id)).variant).toMatchObject({
        weightGrams: null,
        lengthMm: null,
      });
    }
  });

  it('gives the variant on its own to everybody with the data', async () => {
    const { product } = await productWithData();

    for (const actor of [null, buyer, admin]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/products/${product.id}/variants/${product.variantId}`,
        ...(actor ? { headers: { cookie: accessCookie(actor) } } : {}),
      });

      expect(res.json()).toMatchObject({ weightGrams: 350, lengthMm: 200 });
    }
  });
});

// the list of the catalog is the business of the list tests; this names the filter of the
// variants that lack the data
describe('GET /api/products?withoutShippingData=true', () => {
  it('lists the variants of the catalog that lack the weight or the sizes, for an admin', async () => {
    const tag = word();
    const noWeight = await createProduct({ price: 10, name: `Bare ${tag}` });
    const onlyWeight = await createProduct({
      price: 10,
      name: `Weight only ${tag}`,
      weightGrams: 10,
    });
    const whole = await createProduct({
      price: 10,
      name: `Whole ${tag}`,
      weightGrams: 10,
      sizesMm: { length: 1, width: 1, height: 1 },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/products?withoutShippingData=true&search=${tag}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(res.statusCode).toBe(200);
    const ids = res
      .json()
      .items.map((item: { variant: { id: number } }) => item.variant.id)
      .sort((a: number, b: number) => a - b);
    expect(ids).toEqual([noWeight.variantId, onlyWeight.variantId].sort((a, b) => a - b));
    expect(ids).not.toContain(whole.variantId);
  });

  it('refuses a buyer and a guest', async () => {
    for (const headers of [{ cookie: accessCookie(buyer) }, {}]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/products?withoutShippingData=true',
        headers,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        errorCode: 'FILTER_FORBIDDEN',
        details: { filter: 'withoutShippingData' },
      });
    }
  });
});

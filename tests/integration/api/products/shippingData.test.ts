import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { imageField, pngImage } from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { multipartBody, type FormPart } from '../../../helpers/multipart.js';
import { safetyFormFields } from '../../../helpers/productSafety.js';

// what a product weighs and measures packed, the way it is sent (grams and millimetres): the
// shipping needs it whatever the method, the buyer sees it on the card, the admin in the list too. A
// new product has it unless the admin says it comes later (a flag that is not kept); the three
// sizes come together or not at all; clearing what is known needs the flag too

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
let categoryId: number;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
  userIds.push(admin.id, buyer.id);
  categoryId = (await createProduct({ price: 10 })).categoryId;
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// a word of random letters for a search: the search forgives a typo, so words made of a counter
// would find each other
const word = () =>
  Array.from(randomBytes(10), (byte) => String.fromCharCode(97 + (byte % 26))).join('');

const SIZES: FormPart[] = [
  { name: 'lengthMm', value: '200' },
  { name: 'widthMm', value: '100' },
  { name: 'heightMm', value: '50' },
];

const create = (parts: FormPart[]) => {
  const { payload, headers } = multipartBody([
    { name: 'name', value: `Shipping product ${uniqueTag()}` },
    { name: 'price', value: '10' },
    { name: 'categoryId', value: String(categoryId) },
    ...safetyFormFields(),
    ...parts,
    imageField('images', pngImage(30, 20)),
  ]);
  return app.inject({
    method: 'POST',
    url: '/api/products',
    headers: { ...withCsrf(csrf, accessCookie(admin)), ...headers },
    payload,
  });
};

const patch = (productId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
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

const rowOf = (productId: number) =>
  asAdmin((tx) => tx.product.findUniqueOrThrow({ where: { id: productId } }));

const auditOf = (productId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'product', entityId: productId },
      orderBy: { id: 'asc' },
      select: { action: true, meta: true },
    }),
  );

describe('POST /api/products and the weight and the sizes', () => {
  it('creates a product with its weight and its three sizes, and the card shows them', async () => {
    const res = await create([{ name: 'weightGrams', value: '350' }, ...SIZES]);

    expect(res.statusCode).toBe(201);
    const shown = { weightGrams: 350, lengthMm: 200, widthMm: 100, heightMm: 50 };
    expect(res.json()).toMatchObject(shown);
    expect(await cardAs(null, res.json().id)).toMatchObject(shown);
    expect(await rowOf(res.json().id)).toMatchObject(shown);
  });

  it('refuses a product without them and names what is missing', async () => {
    const res = await create([]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
      details: { fields: ['weightGrams', 'sizesMm'] },
    });
  });

  it.each([
    ['the sizes', [{ name: 'weightGrams', value: '350' }], ['sizesMm']],
    ['the weight', SIZES, ['weightGrams']],
  ])('refuses a product without %s and names it', async (_case, parts, fields) => {
    const res = await create(parts as FormPart[]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
      details: { fields },
    });
  });

  it('creates a product without them when the admin says they come later', async () => {
    const res = await create([{ name: 'withoutShippingData', value: 'true' }]);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
    // the flag is not kept: the empty fields say it
    expect(res.json()).not.toHaveProperty('withoutShippingData');
  });

  it('creates a product with a weight and no sizes when the admin says the sizes come later', async () => {
    const res = await create([
      { name: 'weightGrams', value: '350' },
      { name: 'withoutShippingData', value: 'true' },
    ]);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ weightGrams: 350, lengthMm: null });
  });

  it('takes the flag with all the data given, and false as no flag', async () => {
    const full = await create([
      { name: 'weightGrams', value: '350' },
      ...SIZES,
      { name: 'withoutShippingData', value: 'true' },
    ]);
    const refused = await create([{ name: 'withoutShippingData', value: 'false' }]);

    expect(full.statusCode).toBe(201);
    expect(full.json()).toMatchObject({ weightGrams: 350, lengthMm: 200 });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED' });
  });

  it('refuses a flag that is not true or false', async () => {
    const res = await create([{ name: 'withoutShippingData', value: 'yes' }]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_WITHOUT_SHIPPING_DATA_INVALID' });
  });

  it.each([
    ['one size alone', [{ name: 'lengthMm', value: '200' }]],
    [
      'two sizes',
      [
        { name: 'lengthMm', value: '200' },
        { name: 'widthMm', value: '100' },
      ],
    ],
  ])('refuses %s, with the flag too: the sizes come all three or none', async (_case, parts) => {
    const res = await create([
      { name: 'weightGrams', value: '350' },
      { name: 'withoutShippingData', value: 'true' },
      ...(parts as FormPart[]),
    ]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SIZES_INCOMPLETE' });
  });

  it.each(['0', '-5', '1.5', 'abc', '1e3', '1000001', ' '])(
    'refuses the weight %p',
    async (value) => {
      const res = await create([{ name: 'weightGrams', value }, ...SIZES]);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_WEIGHT_INVALID' });
    },
  );

  it.each(['0', '-5', '1.5', 'abc', '10001'])('refuses the size %p', async (value) => {
    const res = await create([
      { name: 'weightGrams', value: '350' },
      { name: 'lengthMm', value },
      { name: 'widthMm', value: '100' },
      { name: 'heightMm', value: '50' },
    ]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SIZES_INVALID' });
  });

  it('takes a ton and ten metres', async () => {
    const res = await create([
      { name: 'weightGrams', value: '1000000' },
      { name: 'lengthMm', value: '10000' },
      { name: 'widthMm', value: '10000' },
      { name: 'heightMm', value: '10000' },
    ]);

    expect(res.statusCode).toBe(201);
  });

  it('writes the weight and the sizes to the admin log with the new product', async () => {
    const res = await create([{ name: 'weightGrams', value: '350' }, ...SIZES]);

    const [line] = await auditOf(res.json().id);
    expect(line!.action).toBe('PRODUCT_CREATE');
    expect(line!.meta).toEqual(
      expect.arrayContaining([
        { field: 'weightGrams', old: null, new: 350 },
        { field: 'lengthMm', old: null, new: 200 },
        { field: 'widthMm', old: null, new: 100 },
        { field: 'heightMm', old: null, new: 50 },
      ]),
    );
  });
});

describe('PATCH /api/products/:productId and the weight and the sizes', () => {
  it('writes the data of a product that has none', async () => {
    const product = await createProduct({ price: 10 });

    const res = await patch(product.id, {
      weightGrams: 350,
      lengthMm: 200,
      widthMm: 100,
      heightMm: 50,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      weightGrams: 350,
      lengthMm: 200,
      widthMm: 100,
      heightMm: 50,
    });
    expect(await rowOf(product.id)).toMatchObject({ weightGrams: 350, heightMm: 50 });
  });

  it('changes one size when the other two are there', async () => {
    const product = await createProduct({
      price: 10,
      weightGrams: 350,
      sizesMm: { length: 200, width: 100, height: 50 },
    });

    const res = await patch(product.id, { widthMm: 120 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lengthMm: 200, widthMm: 120, heightMm: 50 });
  });

  it('refuses one size for a product that has none', async () => {
    const product = await createProduct({ price: 10 });

    const res = await patch(product.id, { lengthMm: 200 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SIZES_INCOMPLETE' });
    expect((await rowOf(product.id)).lengthMm).toBeNull();
  });

  it('changes the price of a product that has no data without asking for them', async () => {
    const product = await createProduct({ price: 10 });

    const res = await patch(product.id, { price: 12 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 12, weightGrams: null });
  });

  it('clears the data only when the admin says so', async () => {
    const product = await createProduct({
      price: 10,
      weightGrams: 350,
      sizesMm: { length: 200, width: 100, height: 50 },
    });

    const refused = await patch(product.id, { weightGrams: null });
    const refusedSizes = await patch(product.id, { lengthMm: null, widthMm: null, heightMm: null });
    const cleared = await patch(product.id, {
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
    expect(cleared.json()).toMatchObject({
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

    const res = await patch(product.id, { heightMm: null, withoutShippingData: true });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SIZES_INCOMPLETE' });
  });

  it.each([
    ['a weight of zero', { weightGrams: 0 }],
    ['a weight over a ton', { weightGrams: 1_000_001 }],
    ['a weight with a fraction', { weightGrams: 1.5 }],
    ['a size of zero', { lengthMm: 0, widthMm: 10, heightMm: 10 }],
    ['a size over ten metres', { lengthMm: 10_001, widthMm: 10, heightMm: 10 }],
  ])('refuses %s by the request schema', async (_case, payload) => {
    const product = await createProduct({ price: 10 });

    const res = await patch(product.id, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('writes the change to the admin log with the old and the new value', async () => {
    const product = await createProduct({ price: 10, weightGrams: 350 });

    await patch(product.id, { weightGrams: 400, lengthMm: 200, widthMm: 100, heightMm: 50 });

    const lines = await auditOf(product.id);
    expect(lines[lines.length - 1]).toMatchObject({ action: 'PRODUCT_UPDATE' });
    expect(lines[lines.length - 1]!.meta).toEqual(
      expect.arrayContaining([
        { field: 'weightGrams', old: 350, new: 400 },
        { field: 'lengthMm', old: null, new: 200 },
      ]),
    );
  });

  it('changes the data of many products at once through the batch', async () => {
    const first = await createProduct({ price: 10 });
    const second = await createProduct({ price: 10 });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/products/batch',
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: {
        items: [
          { productId: first.id, weightGrams: 100, lengthMm: 10, widthMm: 10, heightMm: 10 },
          { productId: second.id, weightGrams: 200 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(await rowOf(first.id)).toMatchObject({ weightGrams: 100, lengthMm: 10 });
    expect(await rowOf(second.id)).toMatchObject({ weightGrams: 200, lengthMm: null });
  });
});

describe('who sees the weight and the sizes of a product', () => {
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
      expect(await cardAs(actor, product.id)).toMatchObject({
        weightGrams: 350,
        lengthMm: 200,
        widthMm: 100,
        heightMm: 50,
      });
      expect(await cardAs(actor, bare.id)).toMatchObject({ weightGrams: null, lengthMm: null });
    }
  });

  it('gives the list to an admin with the data and to a buyer without', async () => {
    const { product, tag } = await productWithData();

    const forAdmin = await app.inject({
      method: 'GET',
      url: `/api/products?search=${tag}`,
      headers: { cookie: accessCookie(admin) },
    });
    const forBuyer = await app.inject({
      method: 'GET',
      url: `/api/products?search=${tag}`,
      headers: { cookie: accessCookie(buyer) },
    });

    const adminItem = forAdmin.json().items.find((item: { id: number }) => item.id === product.id);
    const buyerItem = forBuyer.json().items.find((item: { id: number }) => item.id === product.id);
    expect(adminItem).toMatchObject({
      weightGrams: 350,
      lengthMm: 200,
      widthMm: 100,
      heightMm: 50,
    });
    expect(buyerItem).toBeDefined();
    expect(buyerItem).not.toHaveProperty('weightGrams');
    expect(buyerItem).not.toHaveProperty('lengthMm');
  });
});

describe('GET /api/products?withoutShippingData=true', () => {
  it('lists the products of the catalog that lack the weight or the sizes, for an admin', async () => {
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
      .items.map((item: { id: number }) => item.id)
      .sort((a: number, b: number) => a - b);
    expect(ids).toEqual([noWeight.id, onlyWeight.id].sort((a, b) => a - b));
    expect(ids).not.toContain(whole.id);
  });

  it('takes false as no filter', async () => {
    const tag = word();
    const bare = await createProduct({ price: 10, name: `Bare ${tag}` });
    const whole = await createProduct({
      price: 10,
      name: `Whole ${tag}`,
      weightGrams: 10,
      sizesMm: { length: 1, width: 1, height: 1 },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/products?withoutShippingData=false&search=${tag}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((item: { id: number }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([bare.id, whole.id]));
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

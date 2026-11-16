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
import { formVariant } from '../../../helpers/productForm.js';
import { manufacturerFormFields } from '../../../helpers/productSafety.js';

// what customs need of a product for a parcel that crosses a border: the code of the goods (HS) and
// the country they were made in. Both optional; an admin sets them with the product, changes and
// takes them away, the card shows them, the admin log keeps every change

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let categoryId: number;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  categoryId = (await createProduct({ price: 10 })).categoryId;
});

afterAll(async () => {
  try {
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

const create = (parts: FormPart[]) => {
  const { payload, headers } = multipartBody([
    { name: 'name', value: `Customs product ${uniqueTag()}` },
    { name: 'categoryId', value: String(categoryId) },
    { name: 'variants', value: JSON.stringify([formVariant()]) },
    ...manufacturerFormFields(),
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

const card = async (productId: number) =>
  (await app.inject({ method: 'GET', url: `/api/products/${productId}` })).json().product;

const logOf = (productId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'product', entityId: productId, event },
      select: { meta: true },
      orderBy: { id: 'asc' },
    }),
  );

describe('the customs fields of a product', () => {
  it('takes them with a new product, in the form an admin writes them, and shows them on the card', async () => {
    const res = await create([
      { name: 'hsCode', value: '6105.10 00' },
      { name: 'originCountry', value: 'pt' },
    ]);

    expect(res.statusCode).toBe(201);
    const productId = res.json().product.id;
    expect(res.json().product).toMatchObject({ hsCode: '61051000', originCountry: 'PT' });
    expect(await card(productId)).toMatchObject({ hsCode: '61051000', originCountry: 'PT' });
    expect((await logOf(productId, 'product.create'))[0]!.meta).toEqual(
      expect.arrayContaining([
        { field: 'hsCode', old: null, new: '61051000' },
        { field: 'originCountry', old: null, new: 'PT' },
      ]),
    );
  });

  it('has none for a product made without them', async () => {
    const res = await create([]);

    expect(res.json().product).toMatchObject({ hsCode: null, originCountry: null });
  });

  it('changes them and takes them away with null or an empty text, each in the admin log', async () => {
    const product = await createProduct();

    const set = await patch(product.id, { hsCode: '610510', originCountry: 'CN' });
    const cleared = await patch(product.id, { hsCode: null, originCountry: '  ' });

    expect(set.json().product).toMatchObject({ hsCode: '610510', originCountry: 'CN' });
    expect(cleared.json().product).toMatchObject({ hsCode: null, originCountry: null });
    expect((await logOf(product.id, 'product.update')).map((line) => line.meta)).toEqual([
      [
        { field: 'hsCode', old: null, new: '610510' },
        { field: 'originCountry', old: null, new: 'CN' },
      ],
      [
        { field: 'hsCode', old: '610510', new: null },
        { field: 'originCountry', old: 'CN', new: null },
      ],
    ]);
  });

  it.each([
    ['a code of five digits', { hsCode: '61051' }, 'PRODUCT_HS_CODE_INVALID'],
    ['a code of eleven digits', { hsCode: '61051000001' }, 'PRODUCT_HS_CODE_INVALID'],
    ['a code with letters', { hsCode: '6105AB' }, 'PRODUCT_HS_CODE_INVALID'],
    ['a country of three letters', { originCountry: 'PRT' }, 'PRODUCT_ORIGIN_COUNTRY_INVALID'],
    ['a country with a digit', { originCountry: 'P1' }, 'PRODUCT_ORIGIN_COUNTRY_INVALID'],
  ])('refuses %s and changes nothing', async (_case, body, errorCode) => {
    const product = await createProduct();

    const res = await patch(product.id, body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect(await card(product.id)).toMatchObject({ hsCode: null, originCountry: null });
  });

  it('refuses a new product with a wrong code, and makes nothing', async () => {
    const res = await create([{ name: 'hsCode', value: '12' }]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_HS_CODE_INVALID' });
  });
});

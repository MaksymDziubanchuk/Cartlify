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
import {
  productSafety,
  safetyFormFields,
  shippingFormFields,
  type ProductSafetyInput,
} from '../../../helpers/productSafety.js';

// the safety and origin data of a product (the EU GPSR): the manufacturer with its postal and
// electronic address and its country, a person responsible in the EU for a manufacturer outside
// it, the warnings. The database keeps them in the description of the product, with its text; a
// new product needs them, the card gives them apart from the text

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
    { name: 'name', value: `Safety product ${uniqueTag()}` },
    { name: 'price', value: '10' },
    { name: 'categoryId', value: String(categoryId) },
    ...shippingFormFields(),
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
  (await app.inject({ method: 'GET', url: `/api/products/${productId}` })).json();

const descriptionRowOf = async (productId: number) =>
  (
    await asAdmin((tx) =>
      tx.product.findUniqueOrThrow({ where: { id: productId }, select: { description: true } }),
    )
  ).description;

const outsideEu: ProductSafetyInput = {
  manufacturer: {
    name: 'Shenzhen Light Co.',
    address: '8 Gaoxin Road, Shenzhen, China',
    email: 'info@light.example.com',
    country: 'CN',
  },
  responsiblePerson: {
    name: 'EU Rep s.r.o.',
    address: 'Na Prikope 1, 110 00 Prague, Czechia',
    email: 'rep@eurep.example.com',
  },
  warnings: 'Keep away from water.',
};

describe('POST /api/products and the safety data', () => {
  it('keeps the data in the description and gives them on the card apart from the text', async () => {
    const res = await create([
      { name: 'description', value: 'A warm desk lamp.' },
      ...safetyFormFields({ ...productSafety, warnings: 'Hot surface.' }),
    ]);

    expect(res.statusCode).toBe(201);
    const shown = {
      description: 'A warm desk lamp.',
      safety: { ...productSafety, responsiblePerson: null, warnings: 'Hot surface.' },
    };
    expect(res.json()).toMatchObject(shown);
    expect(await card(res.json().id)).toMatchObject(shown);
    expect(JSON.parse((await descriptionRowOf(res.json().id))!)).toEqual({
      v: 1,
      text: 'A warm desk lamp.',
      safety: shown.safety,
    });
  });

  it('refuses a product without the data of its manufacturer and names what is missing', async () => {
    const res = await create([{ name: 'description', value: 'No maker.' }]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SAFETY_REQUIRED',
      details: {
        fields: [
          'safety.manufacturer.name',
          'safety.manufacturer.address',
          'safety.manufacturer.email',
          'safety.manufacturer.country',
        ],
      },
    });
  });

  it('needs a person responsible in the EU for a manufacturer outside it', async () => {
    const without = await create(safetyFormFields({ ...outsideEu, responsiblePerson: null }));

    expect(without.statusCode).toBe(400);
    expect(without.json()).toMatchObject({ errorCode: 'PRODUCT_EU_RESPONSIBLE_REQUIRED' });

    const withOne = await create(safetyFormFields(outsideEu));
    expect(withOne.statusCode).toBe(201);
    expect(withOne.json().safety).toEqual(outsideEu);
  });

  it.each([
    [
      'a country that is not a code of two letters',
      { country: 'Germany' },
      'safety.manufacturer.country',
    ],
    ['an email without an @', { email: 'safety.example.com' }, 'safety.manufacturer.email'],
  ])('refuses %s', async (_case, change, field) => {
    const res = await create(
      safetyFormFields({
        ...productSafety,
        manufacturer: { ...productSafety.manufacturer, ...change },
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SAFETY_INVALID',
      details: { fields: [field] },
    });
  });
});

describe('PATCH /api/products/:productId and the safety data', () => {
  const created = async () => {
    const res = await create([
      { name: 'description', value: 'First text.' },
      ...safetyFormFields(),
    ]);
    expect(res.statusCode).toBe(201);
    return res.json().id as number;
  };

  it('changes the text and keeps the data', async () => {
    const productId = await created();

    const res = await patch(productId, { description: 'Second text.' });

    expect(res.json()).toMatchObject({
      description: 'Second text.',
      safety: { manufacturer: productSafety.manufacturer },
    });
  });

  it('replaces the data, keeps the text and writes both apart to the admin log', async () => {
    const productId = await created();

    const res = await patch(productId, { safety: outsideEu });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ description: 'First text.', safety: outsideEu });
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'product', entityId: productId, action: 'PRODUCT_UPDATE' },
        select: { meta: true },
      }),
    );
    expect(lines).toEqual([
      {
        meta: [
          {
            field: 'safety',
            old: { ...productSafety, responsiblePerson: null, warnings: null },
            new: outsideEu,
          },
        ],
      },
    ]);
  });

  it('refuses data without the email of the manufacturer', async () => {
    const productId = await created();
    const { name, address, country } = productSafety.manufacturer;
    const manufacturer = { name, address, country };

    const res = await patch(productId, { safety: { manufacturer } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a manufacturer outside the EU without a responsible person', async () => {
    const productId = await created();

    const res = await patch(productId, { safety: { ...outsideEu, responsiblePerson: null } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_EU_RESPONSIBLE_REQUIRED' });
  });

  // a product from before the data, with a plain description
  it('gives the plain description of an older product as its text, with no data', async () => {
    const product = await createProduct({ price: 10 });
    await asAdmin((tx) =>
      tx.product.update({ where: { id: product.id }, data: { description: 'Old text.' } }),
    );

    expect(await card(product.id)).toMatchObject({ description: 'Old text.', safety: null });

    const res = await patch(product.id, { safety: productSafety });
    expect(res.json()).toMatchObject({
      description: 'Old text.',
      safety: { manufacturer: productSafety.manufacturer },
    });
  });

  it('leaves the data out of the list of the catalog', async () => {
    const productId = await created();

    const res = await app.inject({
      method: 'GET',
      url: `/api/products?categoryIds=${categoryId}&limit=100`,
    });

    const item = (res.json().items as Array<{ id: number }>).find((p) => p.id === productId);
    expect(item).toMatchObject({ description: 'First text.' });
    expect(item).not.toHaveProperty('safety');
  });
});

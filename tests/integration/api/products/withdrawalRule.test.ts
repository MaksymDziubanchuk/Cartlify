import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { createProductForm, sendForm } from '../../../helpers/productForm.js';
import { auditLinesOf } from '../../../helpers/variants.js';

// the rule of withdrawal of a product in its card: a buyer sees the rule and what it means (free,
// only while sealed, none), an admin sees besides it where it comes from (the product, a category,
// the default). An admin sets or takes away the rule of a product by the form or by JSON, each
// change in the admin log

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
let hygiene: { id: number };
let bare: { id: number };
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
  hygiene = await createCategory();
  await asAdmin((tx) =>
    tx.category.update({ where: { id: hygiene.id }, data: { withdrawal: 'sealed_hygiene' } }),
  );
  bare = await createCategory();
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct(opts);
  products.push(product);
  return product;
};

const cardOf = (productId: number, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: `/api/products/${productId}`,
    ...(actor ? { headers: { cookie: accessCookie(actor) } } : {}),
  });

const patch = (productId: number, payload: Record<string, unknown>, actor: TestUser = admin) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

const updateLines = (productId: number) => auditLinesOf('product', productId, ['product.update']);
const batchLines = (productId: number) =>
  auditLinesOf('product', productId, ['product.update_batch']);

describe('the rule of withdrawal in the card of a buyer', () => {
  it.each([
    ['a product with no rule in a category with none', () => bare.id, undefined, 'allowed', 'full'],
    [
      'a product that follows its category',
      () => hygiene.id,
      undefined,
      'sealed_hygiene',
      'conditional',
    ],
    ['a product with a rule of its own', () => hygiene.id, 'perishable', 'perishable', 'none'],
    [
      'a product that allows what its category refuses',
      () => hygiene.id,
      'allowed',
      'allowed',
      'full',
    ],
  ] as const)(
    'gives %s the rule it has and its kind',
    async (_case, category, own, rule, right) => {
      const product = await newProduct({
        categoryId: category(),
        ...(own ? { withdrawal: own } : {}),
      });

      const res = await cardOf(product.id);

      expect(res.statusCode).toBe(200);
      // a buyer gets the rule and its kind only: where it comes from is for an admin
      expect(res.json().product.withdrawal).toEqual({ rule, right });
    },
  );

  it('gives a buyer who is signed in the same', async () => {
    const product = await newProduct({ categoryId: hygiene.id });

    const res = await cardOf(product.id, buyer);

    expect(res.json().product.withdrawal).toEqual({ rule: 'sealed_hygiene', right: 'conditional' });
  });

  it('is not part of the rows of a list', async () => {
    const product = await newProduct({ categoryId: hygiene.id });

    const res = await app.inject({ method: 'GET', url: `/api/products?categoryIds=${hygiene.id}` });

    const row = res
      .json()
      .items.find((item: { product: { id: number } }) => item.product.id === product.id);
    expect(row.product).not.toHaveProperty('withdrawal');
  });
});

describe('the rule of withdrawal in the card of an admin', () => {
  it.each([
    [
      'its own',
      () => ({ categoryId: hygiene.id, withdrawal: 'mixed' as const }),
      () => ({
        rule: 'mixed',
        right: 'conditional',
        own: 'mixed',
        source: 'product',
        categoryId: null,
      }),
    ],
    [
      'the one of its category',
      () => ({ categoryId: hygiene.id }),
      () => ({
        rule: 'sealed_hygiene',
        right: 'conditional',
        own: null,
        source: 'category',
        categoryId: hygiene.id,
      }),
    ],
    [
      'the default',
      () => ({ categoryId: bare.id }),
      () => ({ rule: 'allowed', right: 'full', own: null, source: 'default', categoryId: null }),
    ],
  ])('names where the rule comes from: %s', async (_case, opts, expected) => {
    const product = await newProduct(opts());

    const res = await cardOf(product.id, admin);

    expect(res.json().product.withdrawal).toEqual(expected());
  });
});

describe('PATCH /api/products/:productId and the rule', () => {
  it('sets the rule of the product and writes the change to the admin log', async () => {
    const product = await newProduct({ categoryId: hygiene.id });

    const res = await patch(product.id, { withdrawal: 'perishable' });

    expect(res.statusCode).toBe(200);
    expect(res.json().product.withdrawal).toEqual({
      rule: 'perishable',
      right: 'none',
      own: 'perishable',
      source: 'product',
      categoryId: null,
    });
    expect(await updateLines(product.id)).toEqual([
      expect.objectContaining({
        action: 'PRODUCT_UPDATE',
        meta: [{ field: 'withdrawal', old: null, new: 'perishable' }],
      }),
    ]);
  });

  it('takes the rule away with null, and the product follows its category again', async () => {
    const product = await newProduct({ categoryId: hygiene.id, withdrawal: 'perishable' });

    const res = await patch(product.id, { withdrawal: null });

    expect(res.statusCode).toBe(200);
    expect(res.json().product.withdrawal).toMatchObject({
      rule: 'sealed_hygiene',
      own: null,
      source: 'category',
    });
    expect(await updateLines(product.id)).toEqual([
      expect.objectContaining({ meta: [{ field: 'withdrawal', old: 'perishable', new: null }] }),
    ]);
  });

  it('takes the rule away with an empty field of a form', async () => {
    const product = await newProduct({ categoryId: bare.id, withdrawal: 'periodical' });

    const res = await sendForm(
      app,
      csrf,
      'PATCH',
      `/api/products/${product.id}`,
      [{ name: 'withdrawal', value: '' }],
      admin,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().product.withdrawal).toMatchObject({ rule: 'allowed', source: 'default' });
  });

  it('changes the rule with a field of a form', async () => {
    const product = await newProduct({ categoryId: bare.id });

    const res = await sendForm(
      app,
      csrf,
      'PATCH',
      `/api/products/${product.id}`,
      [{ name: 'withdrawal', value: 'sealed_media' }],
      admin,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().product.withdrawal).toMatchObject({
      rule: 'sealed_media',
      own: 'sealed_media',
    });
  });

  it('writes no line for a rule the product has already', async () => {
    const product = await newProduct({ categoryId: bare.id, withdrawal: 'mixed' });

    const res = await patch(product.id, { withdrawal: 'mixed' });

    expect(res.statusCode).toBe(200);
    expect(await updateLines(product.id)).toEqual([]);
  });

  it('changes the rule together with other fields in one line', async () => {
    const product = await newProduct({ categoryId: bare.id, name: 'Before' });

    await patch(product.id, { name: 'After', withdrawal: 'personalised' });

    expect(await updateLines(product.id)).toEqual([
      expect.objectContaining({
        meta: [
          { field: 'name', old: 'Before', new: 'After' },
          { field: 'withdrawal', old: null, new: 'personalised' },
        ],
      }),
    ]);
  });

  it.each(['Allowed', 'sealed', 'none', 7])(
    'refuses %p (WITHDRAWAL_RULE_INVALID)',
    async (value) => {
      const product = await newProduct({ categoryId: bare.id });

      const res = await patch(product.id, { withdrawal: value });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'WITHDRAWAL_RULE_INVALID' });
      expect(await updateLines(product.id)).toEqual([]);
    },
  );

  it('refuses a buyer', async () => {
    const product = await newProduct({ categoryId: bare.id });

    const res = await patch(product.id, { withdrawal: 'allowed' }, buyer);

    expect(res.statusCode).toBe(403);
  });

  it('is changed by moving the product to a category with another rule', async () => {
    const product = await newProduct({ categoryId: bare.id });

    const res = await patch(product.id, { categoryId: hygiene.id });

    expect(res.json().product.withdrawal).toMatchObject({
      rule: 'sealed_hygiene',
      source: 'category',
      categoryId: hygiene.id,
    });
  });
});

describe('PATCH /api/products/batch and the rule', () => {
  const batch = (items: Array<Record<string, unknown>>) =>
    app.inject({
      method: 'PATCH',
      url: '/api/products/batch',
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { items },
    });

  it('sets the rule of each product, takes it away from another, and logs each as a batch change', async () => {
    const first = await newProduct({ categoryId: hygiene.id });
    const second = await newProduct({ categoryId: hygiene.id, withdrawal: 'perishable' });

    const res = await batch([
      { productId: first.id, withdrawal: 'mixed' },
      { productId: second.id, withdrawal: null },
    ]);

    expect(res.statusCode).toBe(200);
    const [one, two] = res.json().products as Array<{ product: { withdrawal: unknown } }>;
    expect(one!.product.withdrawal).toMatchObject({
      rule: 'mixed',
      own: 'mixed',
      source: 'product',
    });
    expect(two!.product.withdrawal).toMatchObject({
      rule: 'sealed_hygiene',
      own: null,
      source: 'category',
    });
    expect(await batchLines(first.id)).toEqual([
      expect.objectContaining({ meta: [{ field: 'withdrawal', old: null, new: 'mixed' }] }),
    ]);
    expect(await batchLines(second.id)).toEqual([
      expect.objectContaining({ meta: [{ field: 'withdrawal', old: 'perishable', new: null }] }),
    ]);
  });

  it('refuses a rule there is not and changes no product of the request', async () => {
    const first = await newProduct({ categoryId: bare.id });
    const second = await newProduct({ categoryId: bare.id });

    const res = await batch([
      { productId: first.id, withdrawal: 'periodical' },
      { productId: second.id, withdrawal: 'forbidden' },
    ]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'WITHDRAWAL_RULE_INVALID',
      details: { products: [{ productId: second.id }] },
    });
    // all or none: the first product keeps what it had
    expect((await cardOf(first.id, admin)).json().product.withdrawal).toMatchObject({
      own: null,
      source: 'default',
    });
  });
});

describe('POST /api/products and the rule', () => {
  const create = (extra: Array<{ name: string; value: string }>, categoryId = bare.id) =>
    createProductForm(app, csrf, admin, { categoryId, extra });

  it('makes a product with the rule of its own, written to the admin log', async () => {
    const res = await create([{ name: 'withdrawal', value: 'personalised' }]);

    expect(res.statusCode).toBe(201);
    const id = res.json().product.id;
    expect(res.json().product.withdrawal).toMatchObject({
      rule: 'personalised',
      right: 'none',
      own: 'personalised',
      source: 'product',
    });
    const line = await asAdmin((tx) =>
      tx.adminAuditLog.findFirstOrThrow({
        where: { entityType: 'product', entityId: id, event: 'product.create' },
        select: { meta: true },
      }),
    );
    expect(line.meta).toEqual(
      expect.arrayContaining([{ field: 'withdrawal', old: null, new: 'personalised' }]),
    );
    products.push({ id, categoryId: bare.id, variantId: res.json().variant.id });
  });

  it('makes a product with no rule, which follows its category', async () => {
    const res = await create([], hygiene.id);

    expect(res.statusCode).toBe(201);
    expect(res.json().product.withdrawal).toMatchObject({ source: 'category', own: null });
    products.push({
      id: res.json().product.id,
      categoryId: hygiene.id,
      variantId: res.json().variant.id,
    });
  });

  it('makes a product with no rule for an empty field of the form', async () => {
    const res = await create([{ name: 'withdrawal', value: '' }]);

    expect(res.statusCode).toBe(201);
    expect(res.json().product.withdrawal).toMatchObject({ own: null, source: 'default' });
    products.push({
      id: res.json().product.id,
      categoryId: bare.id,
      variantId: res.json().variant.id,
    });
  });

  it('refuses a rule there is not, and makes nothing', async () => {
    const before = await asAdmin((tx) => tx.product.count({ where: { categoryId: bare.id } }));

    const res = await create([{ name: 'withdrawal', value: 'forbidden' }]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'WITHDRAWAL_RULE_INVALID' });
    expect(await asAdmin((tx) => tx.product.count({ where: { categoryId: bare.id } }))).toBe(
      before,
    );
  });
});

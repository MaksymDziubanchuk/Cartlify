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
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';

// the rule of withdrawal of a category: the products of it and of the categories below follow it
// while they have no rule of their own and no nearer category has one. An admin sets it when the
// category is made or changed, the change goes to the admin log, and the answer of a change says
// how many products took another rule by it

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const send = (method: 'POST' | 'PATCH', url: string, payload: object, actor: TestUser = admin) =>
  app.inject({ method, url, headers: withCsrf(csrf, accessCookie(actor)), payload });

const newProduct = async (opts: Parameters<typeof createProduct>[0]) => {
  const product = await createProduct(opts);
  products.push(product);
  return product;
};

const lines = (categoryId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'category', entityId: categoryId, event },
      orderBy: { id: 'asc' },
      select: { actorId: true, meta: true },
    }),
  );

const ruleOfProduct = async (productId: number, actor: TestUser = admin) => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/products/${productId}`,
    headers: { cookie: accessCookie(actor) },
  });
  return res.json().product.withdrawal;
};

describe('POST /api/categories and the rule', () => {
  it('makes a category with a rule, and says so in the answer and in the admin log', async () => {
    const tag = uniqueTag();

    const res = await send('POST', '/api/categories', {
      name: `Hygiene ${tag}`,
      slug: `hygiene-${tag}`,
      withdrawal: 'sealed_hygiene',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ withdrawal: 'sealed_hygiene' });
    expect(await lines(res.json().id, 'category.create')).toEqual([
      expect.objectContaining({
        meta: expect.arrayContaining([{ field: 'withdrawal', old: null, new: 'sealed_hygiene' }]),
      }),
    ]);
  });

  it('makes a category with no rule, which follows the one above it', async () => {
    const tag = uniqueTag();

    const res = await send('POST', '/api/categories', {
      name: `Plain ${tag}`,
      slug: `plain-${tag}`,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().withdrawal).toBeNull();
    expect(await lines(res.json().id, 'category.create')).toEqual([
      expect.objectContaining({
        meta: expect.not.arrayContaining([expect.objectContaining({ field: 'withdrawal' })]),
      }),
    ]);
  });

  it.each(['forbidden', 'Allowed', 7])('refuses %p (WITHDRAWAL_RULE_INVALID)', async (value) => {
    const tag = uniqueTag();

    const res = await send('POST', '/api/categories', {
      name: `Bad ${tag}`,
      slug: `bad-${tag}`,
      withdrawal: value,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'WITHDRAWAL_RULE_INVALID' });
    expect(await asAdmin((tx) => tx.category.count({ where: { slug: `bad-${tag}` } }))).toBe(0);
  });

  it('refuses a buyer', async () => {
    const tag = uniqueTag();

    const res = await send(
      'POST',
      '/api/categories',
      { name: `Buyer ${tag}`, slug: `buyer-${tag}`, withdrawal: 'allowed' },
      buyer,
    );

    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /api/categories/:categoryId and the rule', () => {
  it('sets, changes and takes away the rule, each change in the admin log', async () => {
    const category = await createCategory();

    const set = await send('PATCH', `/api/categories/${category.id}`, { withdrawal: 'mixed' });
    const changed = await send('PATCH', `/api/categories/${category.id}`, {
      withdrawal: 'periodical',
    });
    const cleared = await send('PATCH', `/api/categories/${category.id}`, { withdrawal: null });

    expect([set, changed, cleared].map((res) => res.statusCode)).toEqual([200, 200, 200]);
    expect([set, changed, cleared].map((res) => res.json().withdrawal)).toEqual([
      'mixed',
      'periodical',
      null,
    ]);
    expect((await lines(category.id, 'category.update')).map((line) => line.meta)).toEqual([
      [{ field: 'withdrawal', old: null, new: 'mixed' }],
      [{ field: 'withdrawal', old: 'mixed', new: 'periodical' }],
      [{ field: 'withdrawal', old: 'periodical', new: null }],
    ]);
  });

  it('takes the rule away with an empty text as with null', async () => {
    const category = await createCategory({ withdrawal: 'mixed' });

    const res = await send('PATCH', `/api/categories/${category.id}`, { withdrawal: '' });

    expect(res.statusCode).toBe(200);
    expect(res.json().withdrawal).toBeNull();
  });

  it('writes no line for the rule the category has already', async () => {
    const category = await createCategory({ withdrawal: 'mixed' });

    const res = await send('PATCH', `/api/categories/${category.id}`, { withdrawal: 'mixed' });

    expect(res.statusCode).toBe(200);
    expect(res.json().affectedProducts).toBe(0);
    expect(await lines(category.id, 'category.update')).toEqual([]);
  });

  it('changes the rule of the products that follow it, and of no other product', async () => {
    const top = await createCategory();
    const child = await createCategory({ parentId: top.id });
    // a branch that has a rule of its own shields its products from the one above
    const shielded = await createCategory({ parentId: top.id, withdrawal: 'perishable' });
    const following = await newProduct({ categoryId: child.id });
    const direct = await newProduct({ categoryId: top.id });
    const own = await newProduct({ categoryId: child.id, withdrawal: 'allowed' });
    const behind = await newProduct({ categoryId: shielded.id });

    const res = await send('PATCH', `/api/categories/${top.id}`, { withdrawal: 'sealed_media' });

    expect(res.statusCode).toBe(200);
    // the two that follow the category took the rule; the one with a rule of its own and the one
    // behind the nearer category did not
    expect(res.json().affectedProducts).toBe(2);
    expect(await ruleOfProduct(following.id)).toMatchObject({
      rule: 'sealed_media',
      source: 'category',
    });
    expect(await ruleOfProduct(direct.id)).toMatchObject({ rule: 'sealed_media' });
    expect(await ruleOfProduct(own.id)).toMatchObject({ rule: 'allowed', source: 'product' });
    expect(await ruleOfProduct(behind.id)).toMatchObject({
      rule: 'perishable',
      categoryId: shielded.id,
    });
  });

  it('counts the products that go back to the rule above when the rule is taken away', async () => {
    const top = await createCategory({ withdrawal: 'sealed_hygiene' });
    const child = await createCategory({ parentId: top.id, withdrawal: 'mixed' });
    await newProduct({ categoryId: child.id });
    await newProduct({ categoryId: child.id });

    const res = await send('PATCH', `/api/categories/${child.id}`, { withdrawal: null });

    expect(res.json().affectedProducts).toBe(2);
  });

  it('does not count a product that was taken out of the catalog', async () => {
    const category = await createCategory();
    const gone = await newProduct({ categoryId: category.id });
    await newProduct({ categoryId: category.id });
    await asAdmin((tx) =>
      tx.product.update({ where: { id: gone.id }, data: { deletedAt: new Date() } }),
    );

    const res = await send('PATCH', `/api/categories/${category.id}`, { withdrawal: 'mixed' });

    expect(res.json().affectedProducts).toBe(1);
  });

  it('moves the products of a branch under the rule of the new parent, and says no count: the rule was not sent', async () => {
    const ruled = await createCategory({ withdrawal: 'sealed_hygiene' });
    const plain = await createCategory();
    const moved = await createCategory({ parentId: plain.id });
    const product = await newProduct({ categoryId: moved.id });

    const res = await send('PATCH', `/api/categories/${moved.id}`, { parentId: ruled.id });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('affectedProducts');
    expect(await ruleOfProduct(product.id)).toMatchObject({
      rule: 'sealed_hygiene',
      source: 'category',
      categoryId: ruled.id,
    });
  });

  it('leaves the count out of an answer that does not touch the rule', async () => {
    const category = await createCategory();

    const res = await send('PATCH', `/api/categories/${category.id}`, {
      name: `Renamed ${uniqueTag()}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('affectedProducts');
  });

  it.each(['forbidden', 7])('refuses %p (WITHDRAWAL_RULE_INVALID)', async (value) => {
    const category = await createCategory();

    const res = await send('PATCH', `/api/categories/${category.id}`, { withdrawal: value });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'WITHDRAWAL_RULE_INVALID' });
  });

  it('refuses a buyer', async () => {
    const category = await createCategory();

    const res = await send(
      'PATCH',
      `/api/categories/${category.id}`,
      { withdrawal: 'mixed' },
      buyer,
    );

    expect(res.statusCode).toBe(403);
  });
});

describe('the rule in the answers that name a category', () => {
  it('is in the list, null when the category has none', async () => {
    const ruled = await createCategory({ withdrawal: 'sealed_media' });
    const plain = await createCategory();

    const found = async (category: { id: number; name: string }) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/categories?search=${encodeURIComponent(category.name)}`,
        headers: { cookie: accessCookie(admin) },
      });
      return (res.json().items as Array<{ id: number; withdrawal: string | null }>).find(
        (item) => item.id === category.id,
      );
    };

    expect((await found(ruled))?.withdrawal).toBe('sealed_media');
    expect((await found(plain))?.withdrawal).toBeNull();
  });
});

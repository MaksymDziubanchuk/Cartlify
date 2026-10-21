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
  removeProducts,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';

// the tree of the categories, from the top down. PATCH /api/categories/:categoryId moves a
// category with its whole branch: under another category, or to the top with parentId null; never
// inside its own branch (409 CATEGORY_PARENT_CYCLE, the database refuses it too). A new parent
// category is made first and then given its children one PATCH each: POST takes no children.
// DELETE gives the direct children of a category to its parent, or to the top. Every change of a
// parent goes to the journal of the admins

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
const categoryIds: number[] = [];
const products: TestProduct[] = [];

const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, actor = admin) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    ...(payload ? { payload } : {}),
  });

// a category made in the database: the trees of the tests go there, the requests of the app are
// left for what a test checks
async function newCategory(name: string, parentId?: number) {
  const tag = uniqueTag();
  const { id } = await asAdmin((tx) =>
    tx.category.create({
      data: {
        name: `${name} ${tag}`,
        slug: `${name.toLowerCase()}-${tag}`,
        parentId: parentId ?? null,
      },
      select: { id: true },
    }),
  );
  categoryIds.push(id);
  return id;
}

// Electronics > Phones > (Smartphones > Flagships, Push-button), and Accessories at the top
async function tree() {
  const electronics = await newCategory('Electronics');
  const phones = await newCategory('Phones', electronics);
  const smartphones = await newCategory('Smartphones', phones);
  const flagships = await newCategory('Flagships', smartphones);
  const pushButton = await newCategory('Push-button', phones);
  const accessories = await newCategory('Accessories');
  return { electronics, phones, smartphones, flagships, pushButton, accessories };
}

const move = (id: number, parentId: unknown, actor?: TestUser) =>
  send('PATCH', `/api/categories/${id}`, { parentId }, actor);

const parentOf = async (id: number) =>
  (
    await asAdmin((tx) =>
      tx.category.findUniqueOrThrow({ where: { id }, select: { parentId: true } }),
    )
  ).parentId;

const parentChangesOf = (id: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'category', entityId: id, action: 'CATEGORY_UPDATE' },
      orderBy: { id: 'asc' },
      select: { actorId: true, meta: true },
    }),
  );

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    // the children first: a category with a parent goes before the parent
    await asAdmin(async (tx) => {
      for (const id of [...categoryIds].reverse()) {
        await tx.category.deleteMany({ where: { id } });
      }
    });
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('PATCH /api/categories/:categoryId', () => {
  it('moves a category with its whole branch under another category', async () => {
    const t = await tree();

    const res = await move(t.phones, t.accessories);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: t.phones, parentId: t.accessories });
    expect(await parentOf(t.phones)).toBe(t.accessories);
    // the branch went with it
    expect(await parentOf(t.smartphones)).toBe(t.phones);
    expect(await parentOf(t.flagships)).toBe(t.smartphones);
    expect(await parentOf(t.pushButton)).toBe(t.phones);
    expect(await parentChangesOf(t.phones)).toEqual([
      {
        actorId: admin.id,
        meta: [{ field: 'parentId', old: t.electronics, new: t.accessories }],
      },
    ]);
  });

  it('moves a category down into another branch', async () => {
    const t = await tree();

    const res = await move(t.accessories, t.flagships);

    expect(res.statusCode).toBe(200);
    expect(await parentOf(t.accessories)).toBe(t.flagships);
  });

  it('moves a category to the top with a parentId of null', async () => {
    const t = await tree();

    const res = await move(t.smartphones, null);

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('parentId');
    expect(await parentOf(t.smartphones)).toBeNull();
    expect(await parentOf(t.flagships)).toBe(t.smartphones);
  });

  it('refuses a category under itself and changes nothing', async () => {
    const t = await tree();

    const res = await move(t.phones, t.phones);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_PARENT_ID_INVALID' });
    expect(await parentOf(t.phones)).toBe(t.electronics);
  });

  it.each([
    ['its child', 'smartphones'],
    ['its grandchild', 'flagships'],
  ] as const)(
    'refuses a category inside its own branch, under %s, and changes nothing',
    async (_case, target) => {
      const t = await tree();

      const res = await move(t.phones, t[target]);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_PARENT_CYCLE' });
      expect(await parentOf(t.phones)).toBe(t.electronics);
      expect(await parentChangesOf(t.phones)).toEqual([]);
    },
  );

  it('lets a category go under one that was inside it once that one is out of its branch', async () => {
    const t = await tree();

    expect((await move(t.flagships, t.accessories)).statusCode).toBe(200);
    const res = await move(t.phones, t.flagships);

    expect(res.statusCode).toBe(200);
    expect(await parentOf(t.phones)).toBe(t.flagships);
  });

  // two moves at the same time, each fine alone, would make a loop together: one of them waits for
  // the other and is refused
  it('refuses one of two moves at the same time that would make a loop together', async () => {
    const first = await newCategory('First');
    const second = await newCategory('Second');

    const answers = await Promise.all([move(first, second), move(second, first)]);

    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const loop = (await parentOf(first)) === second && (await parentOf(second)) === first;
    expect(loop).toBe(false);
  });

  it('answers 422 CATEGORY_PARENT_NOT_FOUND for a parent that does not exist', async () => {
    const t = await tree();

    const res = await move(t.phones, 2_000_000_000);

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_PARENT_NOT_FOUND' });
  });

  it.each([
    ['a fraction', 1.5],
    ['zero', 0],
    ['a negative number', -1],
    ['a number over the int of postgres', 2_147_483_648],
    ['text', 'abc'],
  ])('refuses a parentId that is %s', async (_case, parentId) => {
    const t = await tree();

    const res = await move(t.phones, parentId);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await parentOf(t.phones)).toBe(t.electronics);
  });

  it('refuses a user', async () => {
    const t = await tree();
    const user = await createUser();
    userIds.push(user.id);

    const res = await move(t.phones, t.accessories, user);

    expect(res.statusCode).toBe(403);
    expect(await parentOf(t.phones)).toBe(t.electronics);
  });
});

describe('POST /api/categories', () => {
  it('creates a category under a parent', async () => {
    const t = await tree();

    const tag = uniqueTag();
    const res = await send('POST', '/api/categories', {
      name: `Chargers ${tag}`,
      slug: `chargers-${tag}`,
      parentId: t.accessories,
    });

    expect(res.statusCode).toBe(201);
    categoryIds.push(res.json().id);
    expect(res.json()).toMatchObject({ parentId: t.accessories });
    expect(await parentOf(res.json().id)).toBe(t.accessories);
  });

  // a new parent category takes no children: they come to it one PATCH each
  it('takes no children', async () => {
    const t = await tree();

    const tag = uniqueTag();
    const res = await send('POST', '/api/categories', {
      name: `Appliances ${tag}`,
      slug: `appliances-${tag}`,
      childIds: [t.electronics],
    });

    if (res.statusCode === 201) categoryIds.push(res.json().id);
    expect(await parentOf(t.electronics)).toBeNull();
  });

  it.each([
    ['a fraction', 1.5],
    ['a number over the int of postgres', 2_147_483_648],
  ])('refuses a parentId that is %s', async (_case, parentId) => {
    const tag = uniqueTag();
    const res = await send('POST', '/api/categories', {
      name: `Bad ${tag}`,
      slug: `bad-${tag}`,
      parentId,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('DELETE /api/categories/:categoryId', () => {
  it('gives the direct children of the category to its parent, with their branches', async () => {
    const t = await tree();

    const res = await send('DELETE', `/api/categories/${t.phones}`);

    expect(res.statusCode).toBe(200);
    expect(await parentOf(t.smartphones)).toBe(t.electronics);
    expect(await parentOf(t.pushButton)).toBe(t.electronics);
    expect(await parentOf(t.flagships)).toBe(t.smartphones);
    for (const child of [t.smartphones, t.pushButton]) {
      expect(await parentChangesOf(child)).toEqual([
        { actorId: admin.id, meta: [{ field: 'parentId', old: t.phones, new: t.electronics }] },
      ]);
    }
  });

  it('makes the children of a deleted top category top categories', async () => {
    const t = await tree();

    const res = await send('DELETE', `/api/categories/${t.electronics}`);

    expect(res.statusCode).toBe(200);
    expect(await parentOf(t.phones)).toBeNull();
    expect(await parentOf(t.smartphones)).toBe(t.phones);
    expect(await parentChangesOf(t.phones)).toEqual([
      { actorId: admin.id, meta: [{ field: 'parentId', old: t.electronics, new: null }] },
    ]);
  });

  it('keeps a category with products and its children where they are', async () => {
    const product = await createProduct();
    products.push(product);
    const child = await newCategory('Kept child', product.categoryId);

    const res = await send('DELETE', `/api/categories/${product.categoryId}`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_HAS_PRODUCTS' });
    expect(await parentOf(child)).toBe(product.categoryId);
  });
});

// the address of the category page comes from the slug, the server takes no category without one
describe('POST /api/categories without a slug', () => {
  it('refuses a category without a slug', async () => {
    const res = await send('POST', '/api/categories', { name: `No slug ${uniqueTag()}` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  createCategory,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';

// PATCH /api/products/:productId/category: an admin moves a product to another category
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
});

afterAll(stopApp);

const move = (productId: number, categoryId: number, actor: TestUser = admin) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/category`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: { categoryId },
  });

const logOf = (productId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'product', entityId: productId, action: 'PRODUCT_UPDATE' },
      select: { actorId: true, meta: true },
    }),
  );

describe('PATCH /api/products/:productId/category', () => {
  it('moves the product, names its new category and the path to it, and keeps the move in the admin log', async () => {
    const parent = await createCategory();
    const child = await createCategory({ parentId: parent.id });
    const product = await createProduct();

    const res = await move(product.id, child.id);
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ id: product.id, category: { id: child.id, name: child.name } });
    // the path is the parents of the category, the top one first
    expect(body.category.path.map((c: { id: number }) => c.id)).toEqual([parent.id]);
    expect(
      (await asAdmin((tx) => tx.product.findUniqueOrThrow({ where: { id: product.id } })))
        .categoryId,
    ).toBe(child.id);
    expect(await logOf(product.id)).toEqual([
      {
        actorId: admin.id,
        meta: [{ field: 'categoryId', old: product.categoryId, new: child.id }],
      },
    ]);
  });

  it('writes no admin log line when the category stays the same', async () => {
    const product = await createProduct();

    const res = await move(product.id, product.categoryId);

    expect(res.statusCode).toBe(200);
    expect(res.json().category.id).toBe(product.categoryId);
    expect(await logOf(product.id)).toEqual([]);
  });

  it('answers 404 for a product that is not there', async () => {
    const category = await createCategory();

    const res = await move(2_000_000_000, category.id);

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 404,
      code: 'PRODUCT_NOT_FOUND',
    });
  });

  it('refuses a user and leaves the product where it is', async () => {
    const category = await createCategory();
    const product = await createProduct();

    const res = await move(product.id, category.id, await createUser());

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 403,
      code: 'INSUFFICIENT_ROLE',
    });
    expect(
      (await asAdmin((tx) => tx.product.findUniqueOrThrow({ where: { id: product.id } })))
        .categoryId,
    ).toBe(product.categoryId);
  });
});

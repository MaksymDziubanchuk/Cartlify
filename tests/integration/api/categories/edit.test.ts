import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  createCategory,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';

// a category made and changed by an admin: the slug is one of a kind, a parent is a category of
// the shop, and the admin log keeps each change of a field
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
});

afterAll(stopApp);

const send = (method: 'POST' | 'PATCH', url: string, payload: object) =>
  app.inject({ method, url, headers: withCsrf(csrf, accessCookie(admin)), payload });

const slugOf = (categoryId: number) =>
  asAdmin((tx) =>
    tx.category.findUniqueOrThrow({ where: { id: categoryId }, select: { slug: true } }),
  );

describe('POST /api/categories', () => {
  it('refuses a slug another category has with 409', async () => {
    const tag = uniqueTag();
    const first = await send('POST', '/api/categories', {
      name: `First ${tag}`,
      slug: `taken-${tag}`,
    });

    const second = await send('POST', '/api/categories', {
      name: `Second ${tag}`,
      slug: `taken-${tag}`,
    });

    expect(first.statusCode).toBe(201);
    expect({ status: second.statusCode, code: second.json().errorCode }).toEqual({
      status: 409,
      code: 'CATEGORY_SLUG_TAKEN',
    });
  });

  it('refuses a parent that does not exist with 422', async () => {
    const tag = uniqueTag();

    const res = await send('POST', '/api/categories', {
      name: `Orphan ${tag}`,
      slug: `orphan-${tag}`,
      parentId: 2_000_000_000,
    });

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 422,
      code: 'CATEGORY_PARENT_NOT_FOUND',
    });
    expect(await asAdmin((tx) => tx.category.count({ where: { slug: `orphan-${tag}` } }))).toBe(0);
  });
});

describe('PATCH /api/categories/:categoryId', () => {
  it('changes the name, the slug and the description, each change in the admin log', async () => {
    const category = await createCategory();
    const before = await asAdmin((tx) =>
      tx.category.findUniqueOrThrow({ where: { id: category.id } }),
    );
    const tag = uniqueTag();

    const res = await send('PATCH', `/api/categories/${category.id}`, {
      name: `Renamed ${tag}`,
      slug: `renamed-${tag}`,
      description: 'A new description.',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: category.id,
      name: `Renamed ${tag}`,
      slug: `renamed-${tag}`,
      description: 'A new description.',
    });
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'category', entityId: category.id, action: 'CATEGORY_UPDATE' },
        select: { actorId: true, meta: true },
      }),
    );
    expect(lines).toEqual([
      {
        actorId: admin.id,
        meta: [
          { field: 'name', old: before.name, new: `Renamed ${tag}` },
          { field: 'slug', old: before.slug, new: `renamed-${tag}` },
          { field: 'description', old: before.description, new: 'A new description.' },
        ],
      },
    ]);
  });

  it('refuses the slug of another category with 409 and keeps its own', async () => {
    const other = await createCategory();
    const category = await createCategory();
    const own = await slugOf(category.id);

    const res = await send('PATCH', `/api/categories/${category.id}`, {
      slug: (await slugOf(other.id)).slug,
    });

    expect({ status: res.statusCode, code: res.json().errorCode }).toEqual({
      status: 409,
      code: 'CATEGORY_SLUG_TAKEN',
    });
    expect(await slugOf(category.id)).toEqual(own);
  });
});

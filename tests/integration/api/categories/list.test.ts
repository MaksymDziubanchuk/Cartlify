import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import {
  closeSessions,
  createCategory,
  createUser,
  uniqueTag,
} from '../../../helpers/factories.js';

// GET /api/categories: the categories of the catalog for everybody, page by page

let app: FastifyInstance;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const list = (query: string, cookie = '') =>
  app.inject({
    method: 'GET',
    url: `/api/categories${query}`,
    headers: cookie ? { cookie } : {},
  });

type Item = { id: number; name: string; slug: string; parentId?: number };

describe('GET /api/categories', () => {
  it('shows a guest and a user the categories that match the search', async () => {
    const tag = uniqueTag();
    const parent = await createCategory({ name: `List parent ${tag}` });
    const child = await createCategory({ name: `List child ${tag}`, parentId: parent.id });
    const user = await createUser();
    userIds.push(user.id);

    for (const cookie of ['', accessCookie(user)]) {
      const res = await list(`?search=${encodeURIComponent(tag)}`, cookie);

      expect(res.statusCode).toBe(200);
      const items = res.json().items as Item[];
      expect(items.map((item) => item.id).sort((a, b) => a - b)).toEqual(
        [parent.id, child.id].sort((a, b) => a - b),
      );
      expect(items.find((item) => item.id === child.id)).toMatchObject({ parentId: parent.id });
      expect(items.find((item) => item.id === parent.id)).not.toHaveProperty('parentId');
    }
  });

  it('gives only the direct children of a category', async () => {
    const tag = uniqueTag();
    const parent = await createCategory({ name: `Children parent ${tag}` });
    const child = await createCategory({ name: `Children child ${tag}`, parentId: parent.id });
    await createCategory({ name: `Children grandchild ${tag}`, parentId: child.id });

    const res = await list(`?parentId=${parent.id}`);

    expect((res.json().items as Item[]).map((item) => item.id)).toEqual([child.id]);
  });

  // every category once, whatever the size of a page
  it('walks every category of the search once, page by page', async () => {
    const tag = uniqueTag();
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1)
      ids.push((await createCategory({ name: `Page ${tag} ${i}` })).id);

    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const res = await list(
        `?search=${encodeURIComponent(tag)}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.statusCode).toBe(200);
      seen.push(...(res.json().items as Item[]).map((item) => item.id));
      cursor = res.json().nextCursor;
    } while (cursor);

    expect([...seen].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
  });

  it('refuses a broken cursor', async () => {
    const res = await list('?cursor=bm90LWpzb24');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createAttributeGroup,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';

// the order of ALL the groups: a list that names every group of the shop, so the file runs alone,
// after the others (*.shopwide.test.ts), while no other file makes or deletes a group
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let user: TestUser;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  user = await createUser();
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, user.id]);
  } finally {
    await stopApp();
  }
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const send = (who: TestUser, method: Method, url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: method === 'GET' ? { cookie: accessCookie(who) } : withCsrf(csrf, accessCookie(who)),
    ...(payload ? { payload } : {}),
  });

const asAdminUser = (method: Method, url: string, payload?: object) =>
  send(admin, method, url, payload);

const errorOf = (res: { statusCode: number; json: () => { errorCode?: string } }) => ({
  status: res.statusCode,
  code: res.json().errorCode,
});

const positionsOf = async (ids: number[]) =>
  (
    await asAdmin((tx) =>
      tx.attributeGroup.findMany({
        where: { id: { in: ids } },
        select: { id: true, position: true },
      }),
    )
  )
    .sort((a, b) => a.position - b.position)
    .map((row) => row.id);

describe('PUT /api/admin/attribute-groups/order', () => {
  const allIds = async () =>
    (await asAdminUser('GET', '/api/admin/attribute-groups'))
      .json()
      .items.map((item: { id: number }) => item.id) as number[];

  it('writes a new order of all the groups and gives the groups in it', async () => {
    const a = await createAttributeGroup();
    const b = await createAttributeGroup();
    const c = await createAttributeGroup();
    const rest = (await allIds()).filter((id) => ![a.id, b.id, c.id].includes(id));

    const res = await asAdminUser('PUT', '/api/admin/attribute-groups/order', {
      ids: [c.id, a.id, ...rest, b.id],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { id: number }) => item.id)).toEqual([
      c.id,
      a.id,
      ...rest,
      b.id,
    ]);
    expect(await positionsOf([a.id, b.id, c.id])).toEqual([c.id, a.id, b.id]);
    expect(res.json().items.map((item: { position: number }) => item.position)).toEqual(
      res.json().items.map((_: unknown, at: number) => at + 1),
    );
  });

  it('refuses a list that leaves a group out, names one that is not there, or names one twice', async () => {
    const a = await createAttributeGroup();
    const all = await allIds();

    const missing = await asAdminUser('PUT', '/api/admin/attribute-groups/order', {
      ids: all.filter((id) => id !== a.id),
    });
    const unknown = await asAdminUser('PUT', '/api/admin/attribute-groups/order', {
      ids: [...all, 2_000_000_000],
    });
    const twice = await asAdminUser('PUT', '/api/admin/attribute-groups/order', {
      ids: [...all, a.id],
    });

    expect(errorOf(missing)).toEqual({ status: 400, code: 'ORDER_IDS_MISMATCH' });
    expect(missing.json().details).toEqual({ missing: [a.id], unknown: [], repeated: [] });
    expect(unknown.json().details).toEqual({ missing: [], unknown: [2_000_000_000], repeated: [] });
    expect(twice.json().details).toEqual({ missing: [], unknown: [], repeated: [a.id] });
  });

  it('refuses a user with 403', async () => {
    const res = await send(user, 'PUT', '/api/admin/attribute-groups/order', { ids: [1] });

    expect(errorOf(res)).toEqual({ status: 403, code: 'INSUFFICIENT_ROLE' });
  });
});

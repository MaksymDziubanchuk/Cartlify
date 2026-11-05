import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// root changes a public field of the shop on the admin pages; an admin who opens the data of
// the shop sees it, and so does a guest who was never signed in, on the page everybody reads.
// *.shopwide.test.ts: the table is one for every test file running next to it, this file runs
// alone while it runs (tests/setup/integration.shopState.ts)

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT' });
  userIds.push(root.id);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const currentValues = async () =>
  (
    await app.inject({
      method: 'GET',
      url: '/api/admin/shop-settings',
      headers: { cookie: accessCookie(root) },
    })
  ).json();

const currentVersion = async () => {
  const history = (
    await app.inject({
      method: 'GET',
      url: '/api/root/shop-settings/history?limit=1',
      headers: { cookie: accessCookie(root) },
    })
  ).json();
  return history.items[0]?.version ?? 0;
};

const put = (body: object) =>
  app.inject({
    method: 'PUT',
    url: '/api/root/shop-settings',
    headers: withCsrf(csrf, accessCookie(root)),
    payload: body,
  });

describe('root changes the name of the shop', () => {
  it('an admin sees it on the admin page, and a guest on the public page nobody signs in for', async () => {
    const baseVersion = await currentVersion();
    const values = await currentValues();
    const { logoUrl: _logoUrl, ...rest } = values;
    const before = values.shopName;

    const shopName = `Flow shop ${Date.now()}`;
    const written = await put({ baseVersion, ...rest, shopName });
    expect(written.statusCode).toBe(200);
    expect(written.json().shopName).toBe(shopName);

    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(admin.id);
    const adminView = await app.inject({
      method: 'GET',
      url: '/api/admin/shop-settings',
      headers: { cookie: accessCookie(admin) },
    });
    expect(adminView.statusCode).toBe(200);
    expect(adminView.json().shopName).toBe(shopName);

    const guestView = await app.inject({ method: 'GET', url: '/api/shop-settings' });
    expect(guestView.statusCode).toBe(200);
    expect(guestView.json().shopName).toBe(shopName);

    // leaves the name as it found it, as every *.shopwide.test.ts here does
    await put({ baseVersion: await currentVersion(), ...rest, shopName: before });
  });
});

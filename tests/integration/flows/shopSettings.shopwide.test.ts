import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// root changes one public setting of the shop on the admin pages; an admin who opens the data of
// the shop sees it, and so does a guest who was never signed in, on the page everybody reads, and
// the history root reads names the change and who made it.
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

const setName = (shopName: string) =>
  app.inject({
    method: 'PUT',
    url: '/api/root/shop-settings/shopName',
    headers: withCsrf(csrf, accessCookie(root)),
    payload: { value: shopName },
  });

describe('root changes the name of the shop', () => {
  it('an admin sees it on the admin page, and a guest on the public page nobody signs in for', async () => {
    const before = (await currentValues()).shopName;

    const shopName = `Flow shop ${Date.now()}`;
    const written = await setName(shopName);
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

    const history = await app.inject({
      method: 'GET',
      url: '/api/root/shop-settings/history?key=shopName&limit=1',
      headers: { cookie: accessCookie(root) },
    });
    expect(history.json().items).toEqual([
      expect.objectContaining({
        key: 'shopName',
        value: shopName,
        setBy: expect.objectContaining({ id: root.id }),
      }),
    ]);

    // leaves the name as it found it, as every *.shopwide.test.ts here does
    expect((await setName(before)).statusCode).toBe(200);
  });
});

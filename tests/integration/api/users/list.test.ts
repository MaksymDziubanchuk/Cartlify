import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { DELETED_AVATAR_COLOR } from '@utils/avatar.util.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { drawnAvatarOf } from '../../../helpers/avatar.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createLoginLog,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';

// the list of users for an admin or root: GET /api/users. A row has the account fields an admin
// table shows, an empty one is null; the last login comes from the login log. Filters go together:
// a part of the email in any case, roles and providers (several through commas), the email check,
// the deleted accounts (left out unless deleted=true). The order is the sign-up time or the last
// login, newest first unless asked; equal values go by id, accounts that never logged in come last
// in either order. Other files make users at the same time, so the users of a test share a part
// of their email no other row has, and the test searches by it

const AVATAR_BASE = 'https://res.cloudinary.com/demo/image/upload/v1/users/1/avatar.jpg';
const DAY = 86_400_000;

let app: FastifyInstance;
let csrf: Csrf;
let adminCookie: string;
let rootCookie: string;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// a part of the email the users of one test share and no other row has; the letter at the end
// keeps the tag of counter 1 from being a part of the tag of counter 10
const newGroup = () => `list-${uniqueTag()}x`;

let members = 0;
const member = (group: string, opts: Parameters<typeof createUser>[0] = {}) =>
  newUser({ email: `${group}-${++members}@example.com`, ...opts });

const listUsers = (cookie: string, query: Record<string, string | number> = {}) => {
  const search = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  ).toString();

  return app.inject({
    method: 'GET',
    url: `/api/users${search ? `?${search}` : ''}`,
    headers: cookie ? { cookie } : {},
  });
};

type ListBody = {
  items: { id: number; role: string }[];
  limit: number;
  nextCursor: string | null;
  total: number;
};

const idsOf = (body: ListBody) => body.items.map((item) => item.id);

// every page of the list, in the order the pages come
async function walk(query: Record<string, string | number>) {
  const ids: number[] = [];
  const totals: number[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const res = await listUsers(adminCookie, { ...query, ...(cursor ? { cursor } : {}) });
    if (res.statusCode !== 200) throw new Error(`a page answered ${res.statusCode}: ${res.body}`);

    const body = res.json() as ListBody;
    ids.push(...idsOf(body));
    totals.push(body.total);
    cursor = body.nextCursor;
    if (++pages > 20) throw new Error('the pages do not end');
  } while (cursor);

  return { ids, totals, pages };
}

const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

const rowOf = (id: number) => asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { id } }));

const deleteAsRoot = (user: TestUser) =>
  app.inject({
    method: 'DELETE',
    url: `/api/users/${user.id}`,
    headers: withCsrf(csrf, rootCookie),
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  adminCookie = accessCookie(await newUser({ role: 'ADMIN' }));
  rootCookie = accessCookie(await newUser({ role: 'ROOT' }));
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('GET /api/users', () => {
  describe('who may read the list', () => {
    // a guest is an actor of its own, the GUEST role; 401 is for a cookie that cannot be renewed
    it('refuses a guest', async () => {
      const res = await listUsers('');

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    });

    it('asks to log in again when the access cookie is not valid', async () => {
      const res = await listUsers('accessToken=not-a-token');

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'LOGIN_REQUIRED' });
    });

    it('refuses a user', async () => {
      const user = await newUser();

      const res = await listUsers(accessCookie(user));

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    });

    it('lets an admin see every role, root accounts too', async () => {
      const group = newGroup();
      const user = await member(group);
      const admin = await member(group, { role: 'ADMIN' });
      const root = await member(group, { role: 'ROOT' });

      const res = await listUsers(adminCookie, { email: group });

      expect(res.statusCode).toBe(200);
      expect(
        res.json().items.map((item: { id: number; role: string }) => [item.id, item.role]),
      ).toEqual([
        [root.id, 'ROOT'],
        [admin.id, 'ADMIN'],
        [user.id, 'USER'],
      ]);
    });

    it('lets root read the list', async () => {
      const group = newGroup();
      const user = await member(group);

      const res = await listUsers(rootCookie, { email: group });

      expect(res.statusCode).toBe(200);
      expect(idsOf(res.json())).toEqual([user.id]);
    });
  });

  describe('a row', () => {
    it('has every field of the account and the time of the last login', async () => {
      const group = newGroup();
      const user = await member(group, { name: 'Anna', locale: 'uk', avatarUrl: AVATAR_BASE });
      const lastLogin = daysAgo(2);
      await createLoginLog(user, daysAgo(10));
      await createLoginLog(user, lastLogin);
      const row = await rowOf(user.id);

      const res = await listUsers(adminCookie, { email: group });

      expect(res.statusCode).toBe(200);
      const sized = (size: number) =>
        AVATAR_BASE.replace('/upload/', `/upload/c_fill,g_face,w_${size},h_${size},f_auto,q_auto/`);
      expect(res.json()).toEqual({
        items: [
          {
            id: user.id,
            email: user.email,
            name: 'Anna',
            role: 'USER',
            authProvider: 'LOCAL',
            isVerified: true,
            locale: 'uk',
            avatarUrls: {
              url32: sized(32),
              url64: sized(64),
              url128: sized(128),
              url256: sized(256),
            },
            avatarIsDefault: false,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            lastLoginAt: lastLogin.toISOString(),
            deletedAt: null,
          },
        ],
        limit: 20,
        nextCursor: null,
        total: 1,
      });
    });

    it('gives null for what the account has not set and for a login that never was', async () => {
      const group = newGroup();
      const user = await member(group);

      const res = await listUsers(adminCookie, { email: group });

      expect(res.json().items).toEqual([
        expect.objectContaining({
          id: user.id,
          name: null,
          locale: null,
          avatarIsDefault: true,
          lastLoginAt: null,
          deletedAt: null,
        }),
      ]);
      // without a picture and a name the avatar is the first letter of the email
      expect(drawnAvatarOf(res.json().items[0].avatarUrls)).toMatchObject({ letter: 'L' });
    });
  });

  describe('filters', () => {
    it('takes the rows of the roles named, several through commas', async () => {
      const group = newGroup();
      await member(group);
      const admin = await member(group, { role: 'ADMIN' });
      const root = await member(group, { role: 'ROOT' });

      const staff = await listUsers(adminCookie, { email: group, role: 'ADMIN,ROOT' });
      const roots = await listUsers(adminCookie, { email: group, role: 'ROOT' });

      expect(staff.statusCode).toBe(200);
      expect(idsOf(staff.json())).toEqual([root.id, admin.id]);
      expect(staff.json().total).toBe(2);
      expect(idsOf(roots.json())).toEqual([root.id]);
    });

    it('takes the rows of the providers named', async () => {
      const group = newGroup();
      await member(group);
      const google = await member(group, { authProvider: 'GOOGLE', providerSub: uniqueTag() });
      const github = await member(group, { authProvider: 'GITHUB', providerSub: uniqueTag() });

      const res = await listUsers(adminCookie, { email: group, authProvider: 'GOOGLE,GITHUB' });

      expect(res.statusCode).toBe(200);
      expect(idsOf(res.json())).toEqual([github.id, google.id]);
    });

    it('takes the rows by the email check, together with the other filters', async () => {
      const group = newGroup();
      await member(group);
      const unverified = await member(group, { isVerified: false });
      await member(group, { role: 'ADMIN', isVerified: false });

      const res = await listUsers(adminCookie, { email: group, isVerified: 'false', role: 'USER' });

      expect(res.statusCode).toBe(200);
      expect(idsOf(res.json())).toEqual([unverified.id]);
    });

    it('leaves a deleted account out unless deleted=true asks for the deleted ones only', async () => {
      const group = newGroup();
      const live = await member(group);
      const gone = await member(group);
      await createLoginLog(gone, daysAgo(1));
      expect((await deleteAsRoot(gone)).statusCode).toBe(200);
      // the deletion takes the email: the account is found by the address it gets
      const goneEmail = `deleted+${gone.id}+`;

      const liveList = await listUsers(adminCookie, { email: group });
      const notAsked = await listUsers(adminCookie, { email: goneEmail });
      const notDeleted = await listUsers(adminCookie, { email: goneEmail, deleted: 'false' });
      const deleted = await listUsers(adminCookie, { email: goneEmail, deleted: 'true' });

      expect(idsOf(liveList.json())).toEqual([live.id]);
      expect(notAsked.json()).toMatchObject({ items: [], total: 0 });
      expect(notDeleted.json()).toMatchObject({ items: [], total: 0 });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().items).toEqual([
        expect.objectContaining({
          id: gone.id,
          name: 'Guest',
          avatarIsDefault: true,
          deletedAt: expect.any(String),
          lastLoginAt: expect.any(String),
        }),
      ]);
      expect(drawnAvatarOf(deleted.json().items[0].avatarUrls)).toEqual({
        letter: 'G',
        color: DELETED_AVATAR_COLOR,
      });
    });
  });

  describe('the email search', () => {
    it('finds a part of the address in any case and without the spaces around it', async () => {
      const group = newGroup();
      const user = await member(group);

      const upper = await listUsers(adminCookie, { email: group.toUpperCase() });
      const middle = await listUsers(adminCookie, { email: group.slice('list-'.length) });
      const spaced = await listUsers(adminCookie, { email: `  ${group} ` });

      expect(idsOf(upper.json())).toEqual([user.id]);
      expect(idsOf(middle.json())).toEqual([user.id]);
      expect(idsOf(spaced.json())).toEqual([user.id]);
    });

    // _ and % are wildcards of a like pattern; in a search they are the characters themselves
    it('takes _ and % as characters, not as wildcards', async () => {
      const group = newGroup();
      const underscore = await newUser({ email: `${group}-a_b@example.com` });
      await newUser({ email: `${group}-axb@example.com` });

      const byUnderscore = await listUsers(adminCookie, { email: `${group}-a_b` });
      const byPercent = await listUsers(adminCookie, { email: `${group}%` });

      expect(idsOf(byUnderscore.json())).toEqual([underscore.id]);
      expect(byPercent.json()).toMatchObject({ items: [], total: 0 });
    });
  });

  describe('order and pages', () => {
    it('lists the newest accounts first unless sortOrder=asc asks for the oldest', async () => {
      const group = newGroup();
      const [a, b, c] = [await member(group), await member(group), await member(group)];

      const newest = await listUsers(adminCookie, { email: group });
      const oldest = await listUsers(adminCookie, { email: group, sortOrder: 'asc' });

      expect(idsOf(newest.json())).toEqual([c!.id, b!.id, a!.id]);
      expect(idsOf(oldest.json())).toEqual([a!.id, b!.id, c!.id]);
    });

    it.each([
      ['desc', [4, 3, 2, 1, 0]],
      ['asc', [0, 1, 2, 3, 4]],
    ])('gives every account once over the pages in the %s order', async (sortOrder, order) => {
      const group = newGroup();
      const users: TestUser[] = [];
      for (let i = 0; i < 5; i++) users.push(await member(group));

      const { ids, totals, pages } = await walk({ email: group, sortOrder, limit: 2 });

      expect(ids).toEqual(order.map((i) => users[i]!.id));
      expect(pages).toBe(3);
      // the total counts the rows of the filters, not of a page
      expect(totals).toEqual([5, 5, 5]);
    });

    // a and e logged in at the same moment: equal values go by id. b and d never logged in
    it.each([
      ['desc', ['c', 'e', 'a', 'd', 'b']],
      ['asc', ['a', 'e', 'c', 'b', 'd']],
    ])(
      'orders by the last login in the %s order, the accounts that never logged in last',
      async (sortOrder, order) => {
        const group = newGroup();
        const sameMoment = daysAgo(3);
        const users: Record<string, TestUser> = {};
        for (const name of ['a', 'b', 'c', 'd', 'e']) users[name] = await member(group);
        await createLoginLog(users.a!, sameMoment);
        await createLoginLog(users.c!, daysAgo(5));
        await createLoginLog(users.c!, daysAgo(1));
        await createLoginLog(users.e!, sameMoment);

        // two to a page: the pages break inside the equal values and inside the never logged in
        const { ids, pages } = await walk({
          email: group,
          sortBy: 'lastLoginAt',
          sortOrder,
          limit: 2,
        });

        expect(ids).toEqual(order.map((name) => users[name]!.id));
        expect(pages).toBe(3);
      },
    );

    it('refuses a cursor of another order', async () => {
      const group = newGroup();
      await member(group);
      await member(group);
      const first = await listUsers(adminCookie, {
        email: group,
        sortBy: 'lastLoginAt',
        limit: 1,
      });
      const { nextCursor } = first.json() as ListBody;
      expect(nextCursor).toEqual(expect.any(String));

      const otherSort = await listUsers(adminCookie, {
        email: group,
        cursor: nextCursor!,
        limit: 1,
      });
      const otherOrder = await listUsers(adminCookie, {
        email: group,
        sortBy: 'lastLoginAt',
        sortOrder: 'asc',
        cursor: nextCursor!,
        limit: 1,
      });

      expect(otherSort.statusCode).toBe(400);
      expect(otherSort.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
      expect(otherOrder.statusCode).toBe(400);
      expect(otherOrder.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    });

    it('refuses a cursor it did not give', async () => {
      const res = await listUsers(adminCookie, { cursor: 'not-a-cursor' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
    });
  });

  describe('a query it does not take', () => {
    it.each([
      ['a limit of 0', { limit: 0 }],
      ['a limit over 100', { limit: 101 }],
      ['an unknown role', { role: 'OWNER' }],
      ['an unknown role among the known ones', { role: 'USER,OWNER' }],
      ['an unknown provider', { authProvider: 'FACEBOOK' }],
      ['an email check that is not true or false', { isVerified: 'yes' }],
      ['an order by another field', { sortBy: 'email' }],
      ['an order that is not asc or desc', { sortOrder: 'up' }],
    ])('refuses %s', async (_case, query) => {
      const res = await listUsers(adminCookie, query);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    });
  });
});

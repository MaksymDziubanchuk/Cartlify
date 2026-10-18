import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser } from '../../../helpers/factories.js';

// the public profile of any user: GET /api/users/:userId. A signed-in visitor sees the name, the
// avatar and the dates of an account, never the email, role, phone, locale or reviews

const AVATAR_BASE = 'https://res.cloudinary.com/demo/image/upload/v1/users/1/avatar.jpg';

let app: FastifyInstance;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const profileOf = (id: number | string, cookie: string) =>
  app.inject({
    method: 'GET',
    url: `/api/users/${typeof id === 'string' ? encodeURIComponent(id) : id}`,
    headers: cookie ? { cookie } : {},
  });

const rowOf = (id: number) => asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { id } }));

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

describe('GET /api/users/:userId', () => {
  it('returns the name, the avatar in four sizes and the dates of another user, and nothing else', async () => {
    const viewer = await newUser();
    const target = await newUser({
      name: 'Anna',
      locale: 'uk',
      phone: '+380501234567',
      avatarUrl: AVATAR_BASE,
    });
    const row = await rowOf(target.id);

    const res = await profileOf(target.id, accessCookie(viewer));

    expect(res.statusCode).toBe(200);
    const sized = (size: number) =>
      AVATAR_BASE.replace('/upload/', `/upload/c_fill,g_face,w_${size},h_${size},f_auto,q_auto/`);
    // exactly these fields: no email, role, phone, locale, verification or reviews
    expect(res.json()).toEqual({
      id: target.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      name: 'Anna',
      avatarUrls: { url32: sized(32), url64: sized(64), url128: sized(128), url256: sized(256) },
    });
  });

  it('leaves out the name and the avatar a user has not set', async () => {
    const viewer = await newUser();
    const target = await newUser();

    const res = await profileOf(target.id, accessCookie(viewer));

    expect(res.json()).toEqual({
      id: target.id,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('lets a user read their own public profile', async () => {
    const user = await newUser({ name: 'Anna' });

    const res = await profileOf(user.id, accessCookie(user));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: user.id, name: 'Anna' });
    expect(res.json()).not.toHaveProperty('email');
  });

  it.each(['ADMIN', 'ROOT'] as const)('shows a %s the same public profile', async (role) => {
    const viewer = await newUser({ role });
    const target = await newUser({ name: 'Anna', phone: '+380501234567' });

    const res = await profileOf(target.id, accessCookie(viewer));

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['createdAt', 'id', 'name', 'updatedAt']);
  });

  it('shows the profile of an admin the same way as any other', async () => {
    const viewer = await newUser();
    const admin = await newUser({ role: 'ADMIN', name: 'Chief' });

    const res = await profileOf(admin.id, accessCookie(viewer));

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('role');
    expect(res.json()).not.toHaveProperty('email');
  });

  it('refuses a guest', async () => {
    const target = await newUser();

    const res = await profileOf(target.id, '');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('answers 404 for a user that does not exist', async () => {
    const viewer = await newUser();

    const res = await profileOf(2_000_000_000, accessCookie(viewer));

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
  });

  it.each([
    ['letters', 'abc'],
    ['zero', '0'],
    ['a negative number', '-1'],
    ['a number with a leading zero', '01'],
    ['an exponent', '1e3'],
    ['spaces around a number', ' 7 '],
    ['a number beyond a safe integer', '99999999999999999999'],
  ])('refuses an id that is %s', async (_case, id) => {
    const viewer = await newUser();

    const res = await profileOf(id, accessCookie(viewer));

    expect(res.statusCode).toBe(400);
  });

  // 9999999999 is a safe integer but no id of the database: a missing user, not a server failure
  it('answers with a client error for an id larger than the database holds', async () => {
    const viewer = await newUser();

    const res = await profileOf(9_999_999_999, accessCookie(viewer));

    expect([400, 404]).toContain(res.statusCode);
  });
});

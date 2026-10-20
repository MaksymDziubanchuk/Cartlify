import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createChatThread,
  createFavorite,
  createLoginLog,
  createProduct,
  createReview,
  createReviewVote,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';

// the profile of any user: GET /api/users/:userId. A signed-in user sees the name, the avatar
// and the dates of an account, never the email, role, phone, locale or reviews. An admin or root
// sees the whole profile but the password, the provider id and the id of the avatar file, the
// open chat of the user with an admin, and the lists the checkboxes ask for (include) of a period
// (from, to: the last 30 days unless asked, at most 60 days)

const AVATAR_BASE = 'https://res.cloudinary.com/demo/image/upload/v1/users/1/avatar.jpg';
const DAY = 86_400_000;

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const profileOf = (id: number | string, cookie: string, query: Record<string, string> = {}) => {
  const search = new URLSearchParams(query).toString();
  return app.inject({
    method: 'GET',
    url: `/api/users/${typeof id === 'string' ? encodeURIComponent(id) : id}${search ? `?${search}` : ''}`,
    headers: cookie ? { cookie } : {},
  });
};

const rowOf = (id: number) => asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { id } }));

const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

// a user with a login 10, 40 and 100 days ago, to see which ones a period takes
async function userWithLogins(): Promise<{ user: TestUser; logins: Record<number, Date> }> {
  const user = await newUser();
  const logins: Record<number, Date> = {};
  for (const days of [10, 40, 100]) {
    logins[days] = daysAgo(days);
    await createLoginLog(user, logins[days]);
  }
  return { user, logins };
}

const loginTimes = (body: { loginLogs?: { createdAt: string }[] }) =>
  (body.loginLogs ?? []).map((log) => log.createdAt);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
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

  // the checkboxes and the period are for an admin: a user who sends them gets the same profile
  it('gives a user no list and no field of an admin, whatever the query asks', async () => {
    const viewer = await newUser();
    const target = await newUser({ name: 'Anna' });
    await createLoginLog(target, daysAgo(1));

    const res = await profileOf(target.id, accessCookie(viewer), {
      include: 'orders,reviews,favorites,votes,loginLogs',
      from: daysAgo(10).toISOString(),
      to: daysAgo(20).toISOString(),
    });

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

describe('GET /api/users/:userId for an admin', () => {
  it.each(['ADMIN', 'ROOT'] as const)(
    'gives a %s the whole profile but the password, the provider id and the avatar file',
    async (role) => {
      const viewer = await newUser({ role });
      const target = await newUser({
        name: 'Anna',
        locale: 'uk',
        phone: '+380501234567',
        avatarUrl: AVATAR_BASE,
        publicId: 'users/1/avatar',
      });
      const row = await rowOf(target.id);

      const res = await profileOf(target.id, accessCookie(viewer));

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: target.id,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        name: 'Anna',
        avatarUrls: expect.objectContaining({ url32: expect.any(String) }),
        email: target.email,
        role: 'USER',
        authProvider: 'LOCAL',
        isVerified: true,
        locale: 'uk',
        phone: '+380501234567',
        openChatThreadId: null,
        period: { from: expect.any(String), to: expect.any(String) },
      });
    },
  );

  it('leaves out the name, the avatar, the locale and the phone a user has not set', async () => {
    const target = await newUser({
      authProvider: 'GITHUB',
      providerSub: 'gh-1',
      isVerified: false,
    });

    const res = await profileOf(target.id, accessCookie(await newUser({ role: 'ADMIN' })));

    expect(res.json()).toEqual({
      id: target.id,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      email: target.email,
      role: 'USER',
      authProvider: 'GITHUB',
      isVerified: false,
      openChatThreadId: null,
      period: expect.any(Object),
    });
  });

  // the admin goes from the profile into the chat the user opened and writes there
  it('gives the id of the open chat of the user with an admin', async () => {
    const target = await newUser();
    const { id: threadId } = await createChatThread(target.id, { type: 'admin', status: 'open' });

    const res = await profileOf(target.id, accessCookie(await newUser({ role: 'ADMIN' })));

    expect(res.json()).toMatchObject({ openChatThreadId: threadId });
  });

  it.each([
    ['a chat with the bot', { type: 'bot', status: 'open' }],
    ['a closed chat with an admin', { type: 'admin', status: 'closed' }],
  ] as const)('gives no chat id for %s', async (_case, chat) => {
    const target = await newUser();
    await createChatThread(target.id, chat);

    const res = await profileOf(target.id, accessCookie(await newUser({ role: 'ADMIN' })));

    expect(res.json()).toMatchObject({ openChatThreadId: null });
  });

  it('gives the lists the checkboxes ask for, newest first, of the last 30 days', async () => {
    const target = await newUser();
    const product = await createProduct({ price: 10 });
    const other = await createProduct();
    const orderId = await placeOrder(app, csrf, target, product, 'cart');
    const review = await createReview(target.id, product.id, { rating: 4, comment: 'Good' });
    await createFavorite(target.id, product.id);
    const othersReview = await createReview((await newUser()).id, other.id);
    await createReviewVote(target.id, othersReview.id, 'UP');
    await createLoginLog(target, daysAgo(2));
    await createLoginLog(target, daysAgo(1));

    const res = await profileOf(target.id, accessCookie(await newUser({ role: 'ADMIN' })), {
      include: 'orders,reviews,favorites,votes,loginLogs',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Date.parse(body.period.to) - Date.parse(body.period.from)).toBe(30 * DAY);
    expect(Math.abs(Date.parse(body.period.to) - Date.now())).toBeLessThan(60_000);
    expect(body.orders).toEqual([
      {
        id: orderId,
        status: 'pending',
        total: 10,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(body.reviews).toEqual([
      {
        id: review.id,
        productId: product.id,
        rating: 4,
        comment: 'Good',
        upVotes: 0,
        downVotes: 0,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(body.favorites).toEqual([
      { id: expect.any(Number), productId: product.id, createdAt: expect.any(String) },
    ]);
    expect(body.votes).toEqual([
      {
        id: expect.any(Number),
        reviewId: othersReview.id,
        action: 'up',
        createdAt: expect.any(String),
      },
    ]);
    const login = {
      id: expect.any(Number),
      createdAt: expect.any(String),
      ipAddress: null,
      userAgent: null,
    };
    expect(body.loginLogs).toEqual([login, login]);
    expect(Date.parse(body.loginLogs[0].createdAt)).toBeGreaterThan(
      Date.parse(body.loginLogs[1].createdAt),
    );
  });

  it('gives only the lists that are checked', async () => {
    const { user } = await userWithLogins();

    const res = await profileOf(user.id, accessCookie(await newUser({ role: 'ADMIN' })), {
      include: 'loginLogs',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('loginLogs');
    for (const list of ['orders', 'reviews', 'favorites', 'votes']) {
      expect(res.json()).not.toHaveProperty(list);
    }
  });

  it('gives no list when nothing is checked', async () => {
    const { user } = await userWithLogins();

    const res = await profileOf(user.id, accessCookie(await newUser({ role: 'ADMIN' })));

    for (const list of ['orders', 'reviews', 'favorites', 'votes', 'loginLogs']) {
      expect(res.json()).not.toHaveProperty(list);
    }
  });

  it('takes the records of the default 30 days only', async () => {
    const { user, logins } = await userWithLogins();

    const res = await profileOf(user.id, accessCookie(await newUser({ role: 'ADMIN' })), {
      include: 'loginLogs',
    });

    expect(loginTimes(res.json())).toEqual([logins[10]!.toISOString()]);
  });

  it('takes the records of the period asked for, dates long ago included', async () => {
    const { user, logins } = await userWithLogins();

    const res = await profileOf(user.id, accessCookie(await newUser({ role: 'ADMIN' })), {
      include: 'loginLogs',
      from: daysAgo(110).toISOString(),
      to: daysAgo(90).toISOString(),
    });

    expect(res.statusCode).toBe(200);
    expect(loginTimes(res.json())).toEqual([logins[100]!.toISOString()]);
  });

  it('takes 30 days before "to" when only "to" comes', async () => {
    const { user, logins } = await userWithLogins();
    const to = daysAgo(35);

    const res = await profileOf(user.id, accessCookie(await newUser({ role: 'ADMIN' })), {
      include: 'loginLogs',
      to: to.toISOString(),
    });

    expect(res.json().period).toEqual({
      from: new Date(to.getTime() - 30 * DAY).toISOString(),
      to: to.toISOString(),
    });
    expect(loginTimes(res.json())).toEqual([logins[40]!.toISOString()]);
  });

  it('takes the time up to now when only "from" comes', async () => {
    const { user, logins } = await userWithLogins();

    const res = await profileOf(user.id, accessCookie(await newUser({ role: 'ADMIN' })), {
      include: 'loginLogs',
      from: daysAgo(50).toISOString(),
    });

    expect(res.statusCode).toBe(200);
    expect(loginTimes(res.json())).toEqual([logins[10]!.toISOString(), logins[40]!.toISOString()]);
  });

  it('takes a period of exactly 60 days', async () => {
    const { user, logins } = await userWithLogins();
    const to = daysAgo(20);

    const res = await profileOf(user.id, accessCookie(await newUser({ role: 'ADMIN' })), {
      include: 'loginLogs',
      from: new Date(to.getTime() - 60 * DAY).toISOString(),
      to: to.toISOString(),
    });

    expect(res.statusCode).toBe(200);
    expect(loginTimes(res.json())).toEqual([logins[40]!.toISOString()]);
  });

  it('refuses a period longer than 60 days', async () => {
    const { user } = await userWithLogins();

    const res = await profileOf(user.id, accessCookie(await newUser({ role: 'ADMIN' })), {
      from: daysAgo(100).toISOString(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PROFILE_PERIOD_TOO_LONG',
      details: { maxDays: 60 },
    });
  });

  it('refuses a period that ends before it starts', async () => {
    const { user } = await userWithLogins();

    const res = await profileOf(user.id, accessCookie(await newUser({ role: 'ADMIN' })), {
      from: daysAgo(10).toISOString(),
      to: daysAgo(20).toISOString(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PROFILE_PERIOD_INVALID' });
  });

  it.each([
    ['a list it does not know', { include: 'orders,secrets' }],
    ['a date that is not a date', { from: 'yesterday' }],
  ])('refuses %s', async (_case, query) => {
    const viewer = await newUser({ role: 'ADMIN' });

    const res = await profileOf(viewer.id, accessCookie(viewer), query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

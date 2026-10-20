import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie, getMe } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createReview,
  createReviewVote,
  createUser,
  removeProducts,
  type TestProduct,
} from '../../../helpers/factories.js';

// the profile a signed-in user reads and edits for themselves: GET /api/users/me and PATCH with
// a json body. The form with an avatar is in meForm.test.ts

const AVATAR_BASE = 'https://res.cloudinary.com/demo/image/upload/v1/users/1/avatar.jpg';

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const newProduct = async () => {
  const product = await createProduct();
  products.push(product);
  return product;
};

const rowOf = (id: number) => asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { id } }));

const patch = (cookie: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: '/api/users/me',
    headers: withCsrf(csrf, cookie),
    payload,
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('GET /api/users/me', () => {
  it('returns the profile of the user and nothing else of the account', async () => {
    const user = await newUser();

    const res = await getMe(app, accessCookie(user));

    expect(res.statusCode).toBe(200);
    // exactly these fields: no password hash, provider id or public id
    expect(res.json()).toEqual({
      id: user.id,
      email: user.email,
      role: 'USER',
      isVerified: true,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      reviews: [],
    });
  });

  it('returns the name, locale, phone and the avatar in four sizes when the user has them', async () => {
    const user = await newUser({
      name: 'Anna',
      locale: 'uk',
      phone: '+380501234567',
      avatarUrl: AVATAR_BASE,
    });

    const res = await getMe(app, accessCookie(user));

    expect(res.json()).toMatchObject({ name: 'Anna', locale: 'uk', phone: '+380501234567' });
    const sized = (size: number) =>
      AVATAR_BASE.replace('/upload/', `/upload/c_fill,g_face,w_${size},h_${size},f_auto,q_auto/`);
    expect(res.json().avatarUrls).toEqual({
      url32: sized(32),
      url64: sized(64),
      url128: sized(128),
      url256: sized(256),
    });
  });

  it('leaves out the fields the user has not filled in', async () => {
    const user = await newUser({ name: 'Anna' });

    const body = (await getMe(app, accessCookie(user))).json();

    expect(body).toHaveProperty('name', 'Anna');
    expect(body).not.toHaveProperty('locale');
    expect(body).not.toHaveProperty('phone');
    expect(body).not.toHaveProperty('avatarUrls');
  });

  it('gives the dates of the account as they are stored', async () => {
    const user = await newUser();
    const row = await rowOf(user.id);

    const body = (await getMe(app, accessCookie(user))).json();

    expect(body.createdAt).toBe(row.createdAt.toISOString());
    expect(body.updatedAt).toBe(row.updatedAt.toISOString());
  });

  it.each(['ADMIN', 'ROOT'] as const)('serves a %s the profile with their role', async (role) => {
    const user = await newUser({ role });

    const res = await getMe(app, accessCookie(user));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: user.id, role });
  });

  describe('reviews', () => {
    it('lists the reviews with a comment, the latest change first, comments trimmed', async () => {
      const user = await newUser();
      const [first, second, third, fourth] = [
        await newProduct(),
        await newProduct(),
        await newProduct(),
        await newProduct(),
      ];
      const older = await createReview(user.id, first!.id, {
        rating: 5,
        comment: 'Great lamp',
        updatedAt: new Date('2026-01-01T10:00:00Z'),
      });
      const newer = await createReview(user.id, fourth!.id, {
        rating: 3,
        comment: '  Works fine  ',
        updatedAt: new Date('2026-02-01T10:00:00Z'),
      });
      // a rating without a text and a text of spaces are not comments
      await createReview(user.id, second!.id, { rating: 4 });
      await createReview(user.id, third!.id, { rating: 4, comment: '   ' });

      const { reviews } = (await getMe(app, accessCookie(user))).json();

      expect(reviews.map((r: { id: number }) => r.id)).toEqual([newer.id, older.id]);
      expect(reviews[0]).toEqual({
        id: newer.id,
        productId: fourth!.id,
        rating: 3,
        userId: user.id,
        createdAt: expect.any(String),
        comment: 'Works fine',
        upVotes: 0,
        downVotes: 0,
        userVote: null,
        updatedAt: '2026-02-01T10:00:00.000Z',
      });
    });

    it('shows only the reviews of the user', async () => {
      const user = await newUser();
      const other = await newUser();
      const product = await newProduct();
      await createReview(other.id, product.id, { rating: 2, comment: 'Not for me' });

      const { reviews } = (await getMe(app, accessCookie(user))).json();

      expect(reviews).toEqual([]);
    });

    it('counts the votes other users gave to a review', async () => {
      const user = await newUser();
      const fan = await newUser();
      const critic = await newUser();
      const product = await newProduct();
      const review = await createReview(user.id, product.id, { rating: 5, comment: 'Nice' });
      await createReviewVote(fan.id, review.id, 'UP');
      await createReviewVote(critic.id, review.id, 'DOWN');

      const { reviews } = (await getMe(app, accessCookie(user))).json();

      expect(reviews[0]).toMatchObject({ upVotes: 1, downVotes: 1, userVote: null });
    });
  });
});

describe('PATCH /api/users/me with json', () => {
  it('changes the name, locale and phone and answers with the whole profile', async () => {
    const user = await newUser({ name: 'Anna' });
    const cookie = accessCookie(user);
    const product = await newProduct();
    await createReview(user.id, product.id, { rating: 5, comment: 'Nice' });
    const before = await rowOf(user.id);

    const res = await patch(cookie, {
      name: 'Anna Smith',
      locale: 'uk',
      phone: '+380501234567',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: user.id,
      email: user.email,
      name: 'Anna Smith',
      locale: 'uk',
      phone: '+380501234567',
    });
    // the same profile GET /api/users/me gives, reviews included
    expect(res.json().reviews).toHaveLength(1);
    const after = await rowOf(user.id);
    expect(after).toMatchObject({ name: 'Anna Smith', locale: 'uk', phone: '+380501234567' });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it('changes only the fields that were sent', async () => {
    const user = await newUser({ name: 'Anna', locale: 'uk', phone: '+380501234567' });

    const res = await patch(accessCookie(user), { name: 'Hanna' });

    expect(res.statusCode).toBe(200);
    expect(await rowOf(user.id)).toMatchObject({
      name: 'Hanna',
      locale: 'uk',
      phone: '+380501234567',
    });
  });

  it('changes nothing of other users', async () => {
    const user = await newUser({ name: 'Anna' });
    const other = await newUser({ name: 'Boris' });

    await patch(accessCookie(user), { name: 'Hanna' });

    expect((await rowOf(other.id)).name).toBe('Boris');
  });

  it('trims the name', async () => {
    const user = await newUser();

    const res = await patch(accessCookie(user), { name: '  Anna  ' });

    expect(res.json().name).toBe('Anna');
  });

  it.each([
    ['name', 'name'],
    ['locale', 'locale'],
  ] as const)('clears the %s when it is sent empty', async (_label, field) => {
    const user = await newUser({ name: 'Anna', locale: 'uk' });

    const res = await patch(accessCookie(user), { [field]: '   ' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty(field);
    expect((await rowOf(user.id))[field]).toBeNull();
  });

  // the service says "clear phone explicitly", the user must have a way to remove a number
  it.each([
    ['an empty string', ''],
    ['null', null],
  ])('clears the phone when it is sent as %s', async (_label, value) => {
    const user = await newUser({ phone: '+380501234567' });

    const res = await patch(accessCookie(user), { phone: value });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('phone');
    expect((await rowOf(user.id)).phone).toBeNull();
  });

  it.each(['+12345678', '+123456789012345'])(
    'takes the phone %s at the length limits',
    async (phone) => {
      const user = await newUser();

      const res = await patch(accessCookie(user), { phone });

      expect(res.statusCode).toBe(200);
      expect(res.json().phone).toBe(phone);
    },
  );

  it.each([
    ['letters', 'abc'],
    ['no plus sign', '380501234567'],
    ['a zero right after the plus', '+0123456789'],
    ['too few digits', '+1234567'],
    ['too many digits', '+1234567890123456'],
    // the same list as the form refuses (meForm.test.ts): one format for both
    ['spaces, brackets and dashes', '+38 (050) 123-45-67'],
    ['a space before the number', ' +380501234567'],
    ['a space after the number', '+380501234567 '],
    ['only spaces', '   '],
  ])('refuses a phone with %s', async (_case, phone) => {
    const user = await newUser({ phone: '+380501234567' });

    const res = await patch(accessCookie(user), { phone });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect((await rowOf(user.id)).phone).toBe('+380501234567');
  });

  it('removes the phone together with another change in one request', async () => {
    const user = await newUser({ name: 'Anna', phone: '+380501234567' });

    const res = await patch(accessCookie(user), { name: 'Hanna', phone: '' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Hanna' });
    expect(res.json()).not.toHaveProperty('phone');
    expect(await rowOf(user.id)).toMatchObject({ name: 'Hanna', phone: null });
  });

  it('leaves the phone as it is when the request does not mention it', async () => {
    const user = await newUser({ phone: '+380501234567' });

    await patch(accessCookie(user), { name: 'Hanna' });

    expect((await rowOf(user.id)).phone).toBe('+380501234567');
  });

  it('refuses a request with nothing to change', async () => {
    const user = await newUser({ name: 'Anna' });

    const res = await patch(accessCookie(user), {});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NO_FIELDS_TO_UPDATE' });
  });

  // a user must never change what the account is: the role, the login or the verification
  it.each([
    ['role', { role: 'ROOT' }],
    ['email', { email: 'taken-over@example.com' }],
    ['isVerified', { isVerified: false }],
    ['passwordHash', { passwordHash: 'x' }],
    ['id', { id: 1 }],
  ])('does not let the user set %s', async (_field, extra) => {
    const user = await newUser({ name: 'Anna' });
    const before = await rowOf(user.id);

    const res = await patch(accessCookie(user), { name: 'Hanna', ...extra });

    expect([200, 400]).toContain(res.statusCode);
    const after = await rowOf(user.id);
    expect(after).toMatchObject({
      id: before.id,
      email: before.email,
      role: before.role,
      isVerified: before.isVerified,
      passwordHash: before.passwordHash,
    });
  });

  describe.each(['name', 'locale'] as const)('the %s length limit', (field) => {
    it('takes 100 characters', async () => {
      const user = await newUser();

      const res = await patch(accessCookie(user), { [field]: 'x'.repeat(100) });

      expect(res.statusCode).toBe(200);
      expect(res.json()[field]).toBe('x'.repeat(100));
    });

    // an emoji is two UTF-16 units but one character, the way a person counts
    it('counts characters, not UTF-16 units', async () => {
      const user = await newUser();

      const res = await patch(accessCookie(user), { [field]: '😀'.repeat(100) });

      expect(res.statusCode).toBe(200);
      expect((await rowOf(user.id))[field]).toBe('😀'.repeat(100));
    });

    it('refuses 101 characters and changes nothing', async () => {
      const user = await newUser({ name: 'Anna', locale: 'uk' });

      const res = await patch(accessCookie(user), { [field]: 'x'.repeat(101) });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      expect(await rowOf(user.id)).toMatchObject({ name: 'Anna', locale: 'uk' });
    });

    it('refuses thousands of characters', async () => {
      const user = await newUser();

      const res = await patch(accessCookie(user), { [field]: 'x'.repeat(5000) });

      expect(res.statusCode).toBe(400);
    });
  });

  it.each(['ADMIN', 'ROOT'] as const)(
    'lets a %s edit their own profile and keeps the role',
    async (role) => {
      const user = await newUser({ role });

      const res = await patch(accessCookie(user), { name: 'Chief' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Chief', role });
      expect((await rowOf(user.id)).role).toBe(role);
    },
  );

  it('refuses a guest', async () => {
    const res = await patch('', { name: 'Anna' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

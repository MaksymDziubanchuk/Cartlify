import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import cloudinary from '@config/cloudinary.js';

import { accessCookie, sessionCookie, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser, uniqueTag, type TestUser } from '../../../helpers/factories.js';
import {
  arrange,
  forget,
  newsletterApi,
  rowsOf,
  SUBSCRIPTIONS,
} from '../../../helpers/newsletterApi.js';

// The subscription of the own address in the export of the data of a person (GET
// /api/users/me/export and, for root, GET /api/users/:userId/export): the subscription and its
// journal with the fields that were agreed by name (notes/newsletter-steps.md, step 5). A new
// column of the tables never joins the export by itself, and no token, hash or salt ever does

const SUBSCRIPTION_FIELDS = [
  'confirmedAt',
  'createdAt',
  'endReason',
  'endedAt',
  'events',
  'locale',
  'source',
  'status',
];
const EVENT_FIELDS = [
  'campaignId',
  'createdAt',
  'event',
  'ip',
  'place',
  'privacyVersion',
  'userAgent',
];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
const userIds: number[] = [];
const addresses: string[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  addresses.push(user.email);
  return user;
};

const exportOf = (cookie: string) =>
  app.inject({ method: 'GET', url: '/api/users/me/export', headers: { cookie } });

const exportByRoot = (id: number) =>
  app.inject({
    method: 'GET',
    url: `/api/users/${id}/export`,
    headers: { cookie: accessCookie(root) },
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT', password: `root-${uniqueTag()}` });
  userIds.push(root.id);
  jest.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' });
});

afterEach(() => {
  jest.clearAllMocks();
});

afterAll(async () => {
  jest.restoreAllMocks();
  try {
    await closeSessions(userIds);
    await forget(addresses);
  } finally {
    await stopApp();
  }
});

describe('the subscription in the export of the person', () => {
  // the way a person makes a subscription and its journal: through the routes of the profile
  it('gives the subscription and its journal with the agreed fields, and no more', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);
    const browser = newsletterApi(app, csrf);
    const as = {
      cookie: sessionCookie(session),
      from: '203.0.113.31',
      userAgent: 'Export-Browser/1.0',
    };
    expect((await browser.post(SUBSCRIPTIONS, { locale: 'en' }, as)).statusCode).toBe(201);
    expect((await browser.patch('/api/newsletters/me', { locale: 'uk' }, as)).statusCode).toBe(200);
    expect((await browser.delete('/api/newsletters/me', as)).statusCode).toBe(200);

    const res = await exportOf(sessionCookie(session));

    expect(res.statusCode).toBe(200);
    const { newsletterSubscriptions } = res.json();
    expect(newsletterSubscriptions).toHaveLength(1);
    const [subscription] = newsletterSubscriptions;
    expect(Object.keys(subscription).sort()).toEqual(SUBSCRIPTION_FIELDS);
    expect(subscription).toMatchObject({
      status: 'ended',
      source: 'account',
      locale: 'uk',
      endReason: 'unsubscribed',
      createdAt: expect.stringMatching(ISO_UTC),
      confirmedAt: expect.stringMatching(ISO_UTC),
      endedAt: expect.stringMatching(ISO_UTC),
    });
    // each step of the person, oldest first, with where it was done from
    expect(subscription.events.map((line: { event: string }) => line.event)).toEqual([
      'subscribed',
      'locale_changed',
      'unsubscribed',
    ]);
    for (const line of subscription.events) {
      expect(Object.keys(line).sort()).toEqual(EVENT_FIELDS);
      expect(line).toMatchObject({
        place: expect.any(String),
        ip: '203.0.113.31',
        userAgent: 'Export-Browser/1.0',
        createdAt: expect.stringMatching(ISO_UTC),
      });
    }
    expect(subscription.events[0]).toMatchObject({ event: 'subscribed', place: 'profile' });
  });

  it('shows an active subscription as it is, with no end', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);
    await newsletterApi(app, csrf).post(SUBSCRIPTIONS, {}, { cookie: sessionCookie(session) });

    const { newsletterSubscriptions } = (await exportOf(sessionCookie(session))).json();

    expect(newsletterSubscriptions).toEqual([
      expect.objectContaining({ status: 'active', endedAt: null, endReason: null }),
    ]);
  });

  it('gives the subscription of the form that sits on the address too', async () => {
    const user = await newUser();
    await arrange({ email: user.email, source: 'form', locale: 'es' });
    const session = await signIn(app, csrf, user);

    const { newsletterSubscriptions } = (await exportOf(sessionCookie(session))).json();

    expect(newsletterSubscriptions).toEqual([
      expect.objectContaining({ source: 'form', status: 'active', locale: 'es', events: [] }),
    ]);
  });

  it('gives every subscription the address has had, the oldest first', async () => {
    const user = await newUser();
    await arrange({ email: user.email, source: 'account', userId: user.id, status: 'ended' });
    await arrange({ email: user.email, source: 'form', status: 'paused_complaint' });
    const session = await signIn(app, csrf, user);

    const { newsletterSubscriptions } = (await exportOf(sessionCookie(session))).json();

    expect(newsletterSubscriptions.map((row: { status: string }) => row.status)).toEqual([
      'ended',
      'paused_complaint',
    ]);
  });

  // an account that never subscribed gets the section with nothing in it
  it('gives an empty list to a person with no subscription', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);

    const res = await exportOf(sessionCookie(session));

    expect(res.statusCode).toBe(200);
    expect(res.json().newsletterSubscriptions).toEqual([]);
  });

  // the export gives what the person agreed to: a request that never was confirmed was not agreed to
  // by anybody, and it may have been made by someone else who typed the address
  it('gives only the subscriptions that were confirmed', async () => {
    const waiting = await newUser();
    await arrange({ email: waiting.email, source: 'form', status: 'pending' });
    await arrange({
      email: waiting.email,
      source: 'form',
      status: 'ended',
      set: { confirmedAt: null },
    });
    const mixed = await newUser();
    await arrange({
      email: mixed.email,
      source: 'form',
      status: 'ended',
      set: { confirmedAt: null },
    });
    await arrange({ email: mixed.email, source: 'form', status: 'paused_complaint' });

    const none = await exportOf(sessionCookie(await signIn(app, csrf, waiting)));
    const one = await exportOf(sessionCookie(await signIn(app, csrf, mixed)));

    expect(none.json().newsletterSubscriptions).toEqual([]);
    expect(one.json().newsletterSubscriptions.map((row: { status: string }) => row.status)).toEqual(
      ['paused_complaint'],
    );
  });

  it('gives nothing of the subscription of another address', async () => {
    const user = await newUser();
    const other = await newUser();
    await arrange({ email: other.email, source: 'account', userId: other.id });
    const session = await signIn(app, csrf, user);

    const res = await exportOf(sessionCookie(session));

    expect(res.json().newsletterSubscriptions).toEqual([]);
    expect(JSON.stringify(res.json())).not.toContain(other.email);
  });

  // what the database keeps to open the link of management or to find the subscription is no data
  // of the person: no token, no hash, no salt, no id of the row
  it('never gives a token, a hash, a salt or an id of a row', async () => {
    const user = await newUser();
    const arranged = await arrange({ email: user.email, source: 'form' });
    const [row] = await rowsOf(user.email);
    const session = await signIn(app, csrf, user);

    const res = await exportOf(sessionCookie(session));

    const body = res.body;
    expect(res.json().newsletterSubscriptions).toHaveLength(1);
    for (const secret of [arranged.manageToken, row!.manageSalt, row!.manageHash, row!.emailHmac]) {
      expect(secret).toEqual(expect.any(String));
      expect(body).not.toContain(secret as string);
    }
    expect(body).not.toMatch(/manageSalt|manageHash|confirmHash|emailHmac|subscriptionId/);
  });

  it('gives the staff the subscription of their own address as well', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    await arrange({ email: admin.email, source: 'account', userId: admin.id });

    const { newsletterSubscriptions } = (await exportOf(accessCookie(admin))).json();

    expect(newsletterSubscriptions).toEqual([expect.objectContaining({ status: 'active' })]);
  });
});

describe('the export of another person, for root', () => {
  it('gives root the subscription of the person', async () => {
    const user = await newUser();
    await arrange({ email: user.email, source: 'account', userId: user.id, locale: 'uk' });

    const res = await exportByRoot(user.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().newsletterSubscriptions).toEqual([
      expect.objectContaining({ source: 'account', status: 'active', locale: 'uk' }),
    ]);
  });

  it('gives root an empty list, and no refusal, for an account that never verified its address', async () => {
    const user = await newUser({ isVerified: false });
    await arrange({ email: user.email, source: 'form' });

    const res = await exportByRoot(user.id);

    expect(res.statusCode).toBe(200);
    // nobody proved the address to this account: what sits on it is not the data of the account
    expect(res.json().newsletterSubscriptions).toEqual([]);
  });

  const deleteByRoot = async (id: number) => {
    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/users/${id}`,
      headers: withCsrf(csrf, accessCookie(root)),
    });
    expect(gone.statusCode).toBe(200);
  };

  // the address of a deleted account is not its own any more, so its subscriptions are found by the
  // id of the account: the one the account made (userId) and the one of the form that its deletion
  // ended (endedUserId). They are the history of what the person agreed to
  it('gives root the subscription of an account that was deleted, which the deletion ended', async () => {
    const user = await newUser();
    await arrange({ email: user.email, source: 'account', userId: user.id, locale: 'uk' });
    await deleteByRoot(user.id);

    const res = await exportByRoot(user.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().newsletterSubscriptions).toEqual([
      expect.objectContaining({
        source: 'account',
        status: 'ended',
        endReason: 'account_deleted',
        locale: 'uk',
      }),
    ]);
    expect(res.json().profile).toMatchObject({ id: user.id });
  });

  it('gives root the subscription of the form that the deletion of the account ended', async () => {
    const user = await newUser();
    await arrange({ email: user.email, source: 'form', locale: 'es' });
    await deleteByRoot(user.id);

    const res = await exportByRoot(user.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().newsletterSubscriptions).toEqual([
      expect.objectContaining({
        source: 'form',
        status: 'ended',
        endReason: 'account_deleted',
        locale: 'es',
      }),
    ]);
    // the journal of a subscription of the form carries the line of the deletion
    const [subscription] = res.json().newsletterSubscriptions;
    expect(subscription.events.map((line: { event: string }) => line.event)).toContain(
      'account_deleted',
    );
  });

  it('gives root an empty list for a deleted account that never subscribed, with no refusal', async () => {
    const user = await newUser();
    await deleteByRoot(user.id);

    const res = await exportByRoot(user.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().newsletterSubscriptions).toEqual([]);
  });

  it('gives a deleted account nothing of the subscriptions of another account', async () => {
    const user = await newUser();
    const other = await newUser();
    await arrange({ email: other.email, source: 'account', userId: other.id });
    await arrange({ email: user.email, source: 'form' });
    await deleteByRoot(user.id);

    const res = await exportByRoot(user.id);

    expect(res.json().newsletterSubscriptions).toHaveLength(1);
    expect(JSON.stringify(res.json())).not.toContain(other.email);
  });

  // an unverified account has no address of its own to export; once deleted, its id is enough
  it('gives root an empty list for an unverified account that was deleted too, nothing sat on it', async () => {
    const user = await newUser({ isVerified: false });
    await arrange({ email: user.email, source: 'form' });
    await deleteByRoot(user.id);

    const res = await exportByRoot(user.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().newsletterSubscriptions).toEqual([]);
  });

  it('gives the same section when root asks about their own account', async () => {
    const own = await newUser({ role: 'ROOT' });
    await arrange({ email: own.email, source: 'account', userId: own.id });

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${own.id}/export`,
      headers: { cookie: accessCookie(own) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().newsletterSubscriptions).toEqual([
      expect.objectContaining({ status: 'active' }),
    ]);
  });
});

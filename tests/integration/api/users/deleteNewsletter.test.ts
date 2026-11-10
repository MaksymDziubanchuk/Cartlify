import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import cloudinary from '@config/cloudinary.js';

import { accessCookie, sessionCookie, signIn } from '../../../helpers/actors.js';
import { dictionaryText } from '../../../helpers/dictionary.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail, type SentMail } from '../../../helpers/mail.js';
import { giveNewsletterRight } from '../../../helpers/newsletterManager.js';
import { arrange, forget, journalOf, rowsOf } from '../../../helpers/newsletterApi.js';
import { SQL } from '../../../helpers/newsletterFns.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';
import { placeOrder } from '../../../helpers/orders.js';

// The newsletter when an account is deleted, by the person (DELETE /api/users/me) or by root
// (DELETE /api/users/:userId): in the same transaction, before the address is made anonymous, what
// is in force on the address ends - the subscription of the account and the one of the form - and the
// mail "your account is deleted" says so, only when something ended

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
const userIds: number[] = [];
const addresses: string[] = [];
const products: TestProduct[] = [];

// what the mail says in each language of the shop when the subscription ended too: the sentence of
// the dictionary of that language (accountDeleted.newsletterEnded), English written out
const SENTENCES = {
  en: 'Your newsletter subscription has been cancelled as well.',
  uk: dictionaryText('uk', 'accountDeleted.newsletterEnded'),
  es: dictionaryText('es', 'accountDeleted.newsletterEnded'),
} as const;

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  addresses.push(user.email);
  return user;
};

const deleteMe = (cookie: string, payload: Record<string, unknown> = {}) =>
  app.inject({
    method: 'DELETE',
    url: '/api/users/me',
    headers: withCsrf(csrf, cookie),
    payload,
  });

const deleteByRoot = (id: number) =>
  app.inject({
    method: 'DELETE',
    url: `/api/users/${id}`,
    headers: withCsrf(csrf, accessCookie(root)),
  });

// the one mail "your account is deleted" the deletion sent
const deletionMail = (mails: SentMail[], user: TestUser): SentMail => {
  const found = mails.filter((mail) => mail.to.includes(user.email));
  expect(found).toHaveLength(1);
  return found[0]!;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT', password: `root-${uniqueTag()}` });
  userIds.push(root.id);

  // the avatar file lives at Cloudinary and the test environment has only made-up keys
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

describe('a person deletes their own account', () => {
  it('ends the subscription of the account and writes it in the journal', async () => {
    const user = await newUser();
    const { id } = await arrange({ email: user.email, source: 'account', userId: user.id });
    const session = await signIn(app, csrf, user);

    const res = await deleteMe(sessionCookie(session), { password: user.password });

    expect(res.statusCode).toBe(204);
    const rows = await rowsOf(user.email);
    expect(rows).toEqual([
      expect.objectContaining({
        id,
        status: 'ended',
        endReason: 'account_deleted',
        endedAt: expect.any(Date),
      }),
    ]);
    const journal = await journalOf(user.email);
    expect(journal.at(-1)).toMatchObject({
      event: 'account_deleted',
      place: 'profile',
      actorId: null,
    });
  });

  it('ends the subscription of the form on the same address too', async () => {
    const user = await newUser();
    await arrange({ email: user.email, source: 'form' });
    const session = await signIn(app, csrf, user);

    const res = await deleteMe(sessionCookie(session), { password: user.password });

    expect(res.statusCode).toBe(204);
    expect(await rowsOf(user.email)).toEqual([
      expect.objectContaining({ source: 'form', status: 'ended', endReason: 'account_deleted' }),
    ]);
  });

  it('ends a subscription paused by a complaint as well', async () => {
    const user = await newUser();
    await arrange({
      email: user.email,
      source: 'account',
      userId: user.id,
      status: 'paused_complaint',
    });
    const session = await signIn(app, csrf, user);

    expect((await deleteMe(sessionCookie(session), { password: user.password })).statusCode).toBe(
      204,
    );

    expect(await rowsOf(user.email)).toEqual([
      expect.objectContaining({ status: 'ended', endReason: 'account_deleted' }),
    ]);
  });

  // a request of the form that waits has its three days; deleting the account is no answer to it
  it('leaves a request that waits for its confirmation, and a subscription that ended before', async () => {
    const user = await newUser();
    const ended = await arrange({
      email: user.email,
      source: 'account',
      userId: user.id,
      status: 'ended',
    });
    const pending = await arrange({ email: user.email, source: 'form', status: 'pending' });
    const mails = watchMail();
    const session = await signIn(app, csrf, user);

    expect((await deleteMe(sessionCookie(session), { password: user.password })).statusCode).toBe(
      204,
    );

    const rows = await rowsOf(user.email);
    expect(rows.find((row) => row.id === ended.id)).toMatchObject({
      status: 'ended',
      endReason: 'unsubscribed',
    });
    expect(rows.find((row) => row.id === pending.id)).toMatchObject({ status: 'pending' });
    // nothing was ended: the mail does not speak of a subscription
    expect(deletionMail(mails, user).text).not.toContain(SENTENCES.en);
  });

  it('leaves the subscription of another address alone', async () => {
    const user = await newUser();
    const other = await newUser();
    const mine = await arrange({ email: user.email, source: 'account', userId: user.id });
    const theirs = await arrange({ email: other.email, source: 'account', userId: other.id });
    const session = await signIn(app, csrf, user);

    expect((await deleteMe(sessionCookie(session), { password: user.password })).statusCode).toBe(
      204,
    );

    expect((await rowsOf(user.email)).find((row) => row.id === mine.id)).toMatchObject({
      status: 'ended',
    });
    expect(await rowsOf(other.email)).toEqual([
      expect.objectContaining({ id: theirs.id, status: 'active' }),
    ]);
  });

  // the deletion that is refused or not confirmed changes nothing, the subscription too
  it('keeps the subscription while the deletion waits for the confirmation of the open orders', async () => {
    const user = await newUser();
    await arrange({ email: user.email, source: 'account', userId: user.id });
    const product = await createProduct({ price: 10, stock: 5 });
    products.push(product);
    await placeOrder(app, csrf, user, product, 'paid');
    const session = await signIn(app, csrf, user);

    const refused = await deleteMe(sessionCookie(session), { password: user.password });

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ errorCode: 'ACCOUNT_HAS_OPEN_ORDERS' });
    expect(await rowsOf(user.email)).toEqual([expect.objectContaining({ status: 'active' })]);

    const confirmed = await deleteMe(sessionCookie(session), {
      password: user.password,
      confirmOpenOrders: true,
    });

    expect(confirmed.statusCode).toBe(204);
    expect(await rowsOf(user.email)).toEqual([expect.objectContaining({ status: 'ended' })]);
  });

  it('keeps the subscription when the password is wrong', async () => {
    const user = await newUser();
    await arrange({ email: user.email, source: 'account', userId: user.id });
    const session = await signIn(app, csrf, user);

    const res = await deleteMe(sessionCookie(session), { password: 'not-the-password' });

    expect(res.statusCode).toBe(403);
    expect(await rowsOf(user.email)).toEqual([expect.objectContaining({ status: 'active' })]);
  });
});

describe('root deletes an account', () => {
  it('ends the subscription and names root in the journal', async () => {
    const user = await newUser();
    await arrange({ email: user.email, source: 'account', userId: user.id });

    const res = await deleteByRoot(user.id);

    expect(res.statusCode).toBe(200);
    expect(await rowsOf(user.email)).toEqual([
      expect.objectContaining({ status: 'ended', endReason: 'account_deleted' }),
    ]);
    expect((await journalOf(user.email)).at(-1)).toMatchObject({
      event: 'account_deleted',
      place: 'admin',
      actorId: root.id,
    });
  });

  it('ends the subscription of the form on the address of a verified account', async () => {
    const user = await newUser();
    await arrange({ email: user.email, source: 'form' });

    expect((await deleteByRoot(user.id)).statusCode).toBe(200);

    expect(await rowsOf(user.email)).toEqual([
      expect.objectContaining({ source: 'form', status: 'ended', endReason: 'account_deleted' }),
    ]);
  });

  // the subscription of the form sits on the address, and nobody proved the address to this account
  it('leaves the subscription of the form on the address of an account that never verified it', async () => {
    const user = await newUser({ isVerified: false });
    await arrange({ email: user.email, source: 'form' });
    const mails = watchMail();

    expect((await deleteByRoot(user.id)).statusCode).toBe(200);

    expect(await rowsOf(user.email)).toEqual([expect.objectContaining({ status: 'active' })]);
    expect(deletionMail(mails, user).text).not.toContain(SENTENCES.en);
  });
});

describe('the mail "your account is deleted"', () => {
  it.each(Object.entries(SENTENCES))(
    'says the subscription was cancelled too, in %s, in the text and the html',
    async (locale, sentence) => {
      const user = await newUser({ locale });
      await arrange({ email: user.email, source: 'account', userId: user.id });
      const mails = watchMail();

      expect((await deleteByRoot(user.id)).statusCode).toBe(200);

      const mail = deletionMail(mails, user);
      expect(mail.text).toContain(sentence);
      expect(mail.html).toContain(sentence);
      // the sentence follows the words that the account is deleted
      expect(mail.text.indexOf(sentence)).toBeGreaterThan(0);
    },
  );

  it('says it once, also for a subscription paused by a complaint', async () => {
    const user = await newUser();
    await arrange({
      email: user.email,
      source: 'account',
      userId: user.id,
      status: 'paused_complaint',
    });
    const mails = watchMail();

    expect((await deleteByRoot(user.id)).statusCode).toBe(200);

    const text = deletionMail(mails, user).text;
    expect(text.split(SENTENCES.en)).toHaveLength(2);
  });

  it('says nothing of a subscription for an account that had none, and the deletion is as before', async () => {
    const user = await newUser({ locale: 'uk' });
    const mails = watchMail();

    const res = await deleteByRoot(user.id);

    expect(res.statusCode).toBe(200);
    const mail = deletionMail(mails, user);
    for (const sentence of Object.values(SENTENCES)) {
      expect(mail.text).not.toContain(sentence);
      expect(mail.html).not.toContain(sentence);
    }
    expect(await rowsOf(user.email)).toEqual([]);
    const row = await asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { id: user.id } }));
    expect(row.deletedAt).not.toBeNull();
    expect(row.email).toMatch(/^deleted\+/);
  });
});

// An admin erased the address of a person who has an account (DELETE /api/newsletters/subscribers/:id):
// the subscription of the account is made anonymous in place and keeps its userId, because the account
// itself holds the address. Deleting the account afterwards finds nothing in force on it
describe('an account whose subscription an admin erased', () => {
  const erasedRow = (id: number) =>
    inOwnerTx((db) =>
      db.rows<{
        email: string;
        userId: number | null;
        status: string;
        endReason: string | null;
        events: number;
      }>(
        `select s.email, s."userId", s.status::text as status, s."endReason"::text as "endReason",
                (select count(*)::int from cartlify.newsletter_subscription_events e
                  where e."subscriptionId" = s.id) as events
         from cartlify.newsletter_subscriptions s where s.id = $1`,
        id,
      ),
    );

  it('is deleted all the same, and the erased row is left as the erasure made it', async () => {
    const user = await newUser();
    const manager = await newUser({ role: 'ADMIN' });
    await giveNewsletterRight(root.id, manager.id);
    const { id } = await arrange({ email: user.email, source: 'account', userId: user.id });
    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ADMIN', userId: manager.id });
        await db.rows(SQL.adminErase, id);
      },
      { commit: true },
    );
    const [erased] = await erasedRow(id);
    expect(erased).toMatchObject({
      email: `deleted+${id}@deleted.invalid`,
      userId: user.id,
      status: 'ended',
      endReason: 'removed_by_admin',
    });
    const mails = watchMail();
    const session = await signIn(app, csrf, user);

    const res = await deleteMe(sessionCookie(session), { password: user.password });

    // nothing is in force on the account, so the deletion ends nothing and says nothing of it
    expect(res.statusCode).toBe(204);
    expect(await erasedRow(id)).toEqual([erased]);
    expect(deletionMail(mails, user).text).not.toContain(SENTENCES.en);
    const row = await asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { id: user.id } }));
    expect(row.deletedAt).not.toBeNull();
  });
});

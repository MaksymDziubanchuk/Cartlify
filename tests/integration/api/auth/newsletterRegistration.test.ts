import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createUser,
  createVerifyToken,
  uniqueEmail,
  uniqueTag,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import {
  linkParams,
  linkParts,
  mailedToken,
  watchMail,
  watchNewsletterMail,
  type SentMail,
} from '../../../helpers/mail.js';
import { arrange, forget, journalOf, rowsOf } from '../../../helpers/newsletterApi.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';
import { withCaptcha } from '../../../helpers/turnstile.js';

// The newsletter at the registration with a password: the box ticked on the form rides to the page
// that verifies the email as a hint in the link of the mail (newsletter=1) and is stored nowhere;
// the choice that counts is the one the page sends with the token when the person presses the
// button (POST /api/auth/verify with { token, newsletter: true }). The refusals of the subscription itself
// are in tests/integration/api/newsletters and tests/integration/db

const PAGE = '/web/login';

let app: FastifyInstance;
let csrf: Csrf;
const emails: string[] = [];

const newEmail = () => {
  const email = uniqueEmail('news-reg');
  emails.push(email);
  return email;
};

const register = (body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: withCsrf(csrf),
    payload: withCaptcha({ password: 'password123', ...body }),
  });

const resend = (email: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/verify/resend',
    headers: withCsrf(csrf),
    payload: withCaptcha({ email }),
  });

// the page of the shop presses the button: the token of the link and the choice of the box
const verify = (token: string, choice?: string | boolean, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    headers: { ...withCsrf(csrf), ...headers },
    payload: { token, ...(choice === undefined ? {} : { newsletter: choice }) },
  });

// an account whose email is not verified yet and the link a mail would carry
async function unverified(opts: Parameters<typeof createUser>[0] = {}) {
  const user = await createUser({ email: newEmail(), isVerified: false, ...opts });
  return { user, token: await createVerifyToken(user.id) };
}

const verifiedOf = async (id: number) =>
  (
    await asAdmin((tx) =>
      tx.user.findUniqueOrThrow({ where: { id }, select: { isVerified: true } }),
    )
  ).isVerified;

// the version of the privacy policy in force, the one a line of consent keeps
const policyVersion = () =>
  inOwnerTx(async (db) => {
    const [row] = await db.rows<{ version: number | null }>(
      'select cartlify.current_privacy_version() as version',
    );
    return row!.version;
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    const users = await asAdmin((tx) =>
      tx.user.findMany({ where: { email: { in: emails } }, select: { id: true } }),
    );
    await closeSessions(users.map((u) => u.id));
    await forget(emails);
  } finally {
    await stopApp();
  }
});

describe('POST /api/auth/register with the newsletter box', () => {
  it('puts the hint in the link of the mail when the box is ticked', async () => {
    const mails = watchMail();

    const res = await register({ email: newEmail(), newsletter: true });

    expect(res.statusCode).toBe(201);
    const params = linkParams(mails[0]!, PAGE)!;
    expect(params.get('newsletter')).toBe('1');
    expect(params.get('token')).toEqual(expect.any(String));
    // the button of the html part carries it too
    expect(mails[0]!.html).toContain('newsletter=1');
  });

  // a token in the query would reach the logs of every host and proxy between the mail and the
  // person; after the # it never leaves the browser, and the page posts it to the API
  it('puts the token and the hint after the # of the link, and nothing in its query', async () => {
    const mails = watchMail();

    await register({ email: newEmail(), newsletter: true });

    const parts = linkParts(mails[0]!, PAGE)!;
    expect([...parts.query]).toEqual([]);
    expect(parts.fragment.get('token')).toEqual(expect.any(String));
    expect(parts.fragment.get('newsletter')).toBe('1');
    expect(mails[0]!.text).not.toContain('?token=');
    expect(mails[0]!.html).not.toContain('?token=');
    expect(mails[0]!.html).toContain('#token=');
  });

  it.each([
    ['unticked', { newsletter: false }],
    ['absent', {}],
  ])('puts no hint in the link when the box is %s', async (_case, extra) => {
    const mails = watchMail();

    const res = await register({ email: newEmail(), ...extra });

    expect(res.statusCode).toBe(201);
    const params = linkParams(mails[0]!, PAGE)!;
    expect(params.has('newsletter')).toBe(false);
    expect(params.get('token')).toEqual(expect.any(String));
    expect(mails[0]!.html).not.toContain('newsletter=');
  });

  // the box changes the link and nothing else: the answer is the one of a registration without it
  it('answers the same whether the box is ticked or not, and stores nothing of it', async () => {
    watchMail();
    const ticked = newEmail();
    const plain = newEmail();

    const withBox = await register({ email: ticked, newsletter: true, name: 'Ann' });
    const without = await register({ email: plain, name: 'Ann' });

    expect(withBox.statusCode).toBe(without.statusCode);
    // what differs between two accounts by itself: the id, the address, the dates, the drawn avatar
    const strip = ({
      id: _id,
      email: _email,
      createdAt: _c,
      updatedAt: _u,
      avatarUrls: _a,
      ...rest
    }: any) => rest;
    expect(strip(withBox.json())).toEqual(strip(without.json()));
    expect(Object.keys(withBox.json())).toEqual(Object.keys(without.json()));
    // no subscription and no journal: the registration subscribes nobody
    expect(await rowsOf(ticked)).toEqual([]);
    expect(await journalOf(ticked)).toEqual([]);
    // no column of the account remembers the box
    const row = await asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { email: ticked } }));
    expect(JSON.stringify(row)).not.toMatch(/newsletter(?!s)/i);
  });

  // the box is a boolean; a value that is not one is refused before anything is done
  it.each([['yes'], ['maybe'], [{}], [[true]]])('refuses %j as the box', async (value) => {
    const mails = watchMail();
    const email = newEmail();

    const res = await register({ email, newsletter: value });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(mails).toHaveLength(0);
    expect(
      await asAdmin((tx) => tx.user.findUnique({ where: { email }, select: { id: true } })),
    ).toBeNull();
  });

  it('puts the hint in the link of the new mail when it takes over an unverified account', async () => {
    const taken = await createUser({ email: newEmail(), isVerified: false });
    const mails = watchMail();

    const res = await register({ email: taken.email, newsletter: true });

    expect(res.statusCode).toBe(201);
    expect(linkParams(mails[0]!, PAGE)!.get('newsletter')).toBe('1');
  });

  // the resend route does not know what the form said: a link of a resent mail carries no hint,
  // the page then shows the box unticked and the person ticks it if they want
  it('mails a resent link without the hint', async () => {
    const mails = watchMail();
    const email = newEmail();
    await register({ email, newsletter: true });
    expect(linkParams(mails[0]!, PAGE)!.get('newsletter')).toBe('1');

    const res = await resend(email);

    expect(res.statusCode).toBe(200);
    expect(mails).toHaveLength(2);
    const params = linkParams(mails[1]!, PAGE)!;
    expect(params.has('newsletter')).toBe(false);
    expect(params.get('token')).toEqual(expect.any(String));
  });
});

describe('POST /api/auth/verify with the choice of the person', () => {
  it('subscribes the account once the email is verified, when the choice is yes', async () => {
    const { user, token } = await unverified();
    const mails = watchMail();
    const newsletterMails = watchNewsletterMail();

    const res = await verify(token, true, {
      'x-forwarded-for': '203.0.113.21',
      'user-agent': 'Verify-Browser/1.0',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Email verified' });
    expect(await verifiedOf(user.id)).toBe(true);

    const [row, ...more] = await rowsOf(user.email);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ source: 'account', status: 'active', userId: user.id });
    // the journal: the one line of consent, placed at the registration with the address and the
    // browser of the request and the privacy policy of the day
    const journal = await journalOf(user.email);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      event: 'subscribed',
      place: 'registration',
      ip: '203.0.113.21',
      userAgent: 'Verify-Browser/1.0',
      privacyVersion: await policyVersion(),
    });
    // no mail about the subscription, none after the verification
    expect(mails).toHaveLength(0);
    expect(newsletterMails).toHaveLength(0);
  });

  it('takes the language of the account for the subscription when the shop answers in it', async () => {
    const { user, token } = await unverified({ locale: 'uk' });

    expect((await verify(token, true)).statusCode).toBe(200);

    expect(await rowsOf(user.email)).toEqual([expect.objectContaining({ locale: 'uk' })]);
  });

  it.each([
    // 'zv' is used by no other file: the account stays alive in the shared database, and the DB tests
    // that count the accounts of a made-up language ('zz', 'zy', 'zx') must not meet it
    ['one the shop does not answer in', 'zv'],
    ['none', undefined],
  ])('subscribes without a language when the account has %s', async (_case, locale) => {
    const { user, token } = await unverified(locale ? { locale } : {});

    expect((await verify(token, true)).statusCode).toBe(200);

    expect(await rowsOf(user.email)).toEqual([expect.objectContaining({ locale: null })]);
  });

  it.each([
    ['is no', false],
    ['is not given', undefined],
  ])('verifies the email and subscribes nobody when the choice %s', async (_case, choice) => {
    const { user, token } = await unverified();

    const res = await verify(token, choice);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Email verified' });
    expect(await verifiedOf(user.id)).toBe(true);
    expect(await rowsOf(user.email)).toEqual([]);
    expect(await journalOf(user.email)).toEqual([]);
  });

  // the hint of the link is only a hint for the page; what counts is what the page sends
  it('ignores the hint of the link: a registration with the box ticked, verified with no choice', async () => {
    const mails = watchMail();
    const email = newEmail();
    await register({ email, newsletter: true });
    const token = mailedToken(mails, PAGE);

    const res = await verify(token);

    expect(res.statusCode).toBe(200);
    expect(await rowsOf(email)).toEqual([]);
  });

  it('subscribes on the choice of the person alone, whatever the registration said', async () => {
    const mails = watchMail();
    const email = newEmail();
    await register({ email });
    const token = mailedToken(mails, PAGE);

    const res = await verify(token, true);

    expect(res.statusCode).toBe(200);
    expect(await rowsOf(email)).toEqual([expect.objectContaining({ status: 'active' })]);
  });

  // the answer never says whether the address was subscribed already
  it.each([
    ['of the form', { source: 'form' as const }],
    ['of an account', { source: 'account' as const }],
  ])(
    'changes nothing and answers the same when the address has an active subscription %s',
    async (_case, opts) => {
      const fresh = await unverified();
      const baseline = await unverified();
      const existing = await arrange({
        email: fresh.user.email,
        userId: fresh.user.id,
        ...opts,
      });
      const before = await rowsOf(fresh.user.email);
      const journalBefore = await journalOf(fresh.user.email);

      const res = await verify(fresh.token, true);
      const plain = await verify(baseline.token, true);

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(plain.body);
      expect(res.headers['content-type']).toBe(plain.headers['content-type']);
      expect(await rowsOf(fresh.user.email)).toEqual(before);
      expect(before).toHaveLength(1);
      expect(before[0]!.id).toBe(existing.id);
      expect(await journalOf(fresh.user.email)).toEqual(journalBefore);
    },
  );

  // an address with a request of the form that waits: the person proved the address, the request
  // becomes the subscription of the account, the same row
  it('turns a request of the form that waits into the subscription of the account', async () => {
    const { user, token } = await unverified();
    const pending = await arrange({ email: user.email, source: 'form', status: 'pending' });

    const res = await verify(token, true);

    expect(res.statusCode).toBe(200);
    expect(await rowsOf(user.email)).toEqual([
      expect.objectContaining({
        id: pending.id,
        source: 'account',
        status: 'active',
        userId: user.id,
      }),
    ]);
  });

  // the account is not named by the choice, only by the token: a wrong token reaches no account
  it('subscribes nobody on a token that is wrong', async () => {
    const { user } = await unverified();

    const res = await verify('made-up-token-0123456789', true);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VERIFY_TOKEN_INVALID_OR_EXPIRED' });
    expect(await verifiedOf(user.id)).toBe(false);
    expect(await rowsOf(user.email)).toEqual([]);
  });

  it('subscribes nobody on a link that was used', async () => {
    const { user, token } = await unverified();
    expect((await verify(token)).statusCode).toBe(200);

    const again = await verify(token, true);

    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ errorCode: 'VERIFY_TOKEN_INVALID_OR_EXPIRED' });
    expect(await rowsOf(user.email)).toEqual([]);
  });

  it('subscribes nobody on a link past its deadline', async () => {
    const user = await createUser({ email: newEmail(), isVerified: false });
    const token = await createVerifyToken(user.id, {
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await verify(token, true);

    expect(res.statusCode).toBe(400);
    expect(await verifiedOf(user.id)).toBe(false);
    expect(await rowsOf(user.email)).toEqual([]);
  });

  it('refuses a choice that is not a boolean, with the email left unverified', async () => {
    const { user, token } = await unverified();

    const res = await verify(token, 'maybe');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await verifiedOf(user.id)).toBe(false);
    expect(await rowsOf(user.email)).toEqual([]);
  });

  // the subscription is a second step, it cannot take back what the first one did
  it('keeps the email verified and answers as before when the subscription fails', async () => {
    // an address with a space inside passes the table of the accounts and not the one of the
    // subscriptions, so the subscription of the account is refused by the database
    const { user, token } = await unverified({ email: `has space ${uniqueTag()}@example.com` });
    emails.push(user.email);

    const res = await verify(token, true);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Email verified' });
    expect(await verifiedOf(user.id)).toBe(true);
    expect(await rowsOf(user.email)).toEqual([]);

    const logged = takeLogs({ msg: 'newsletter subscription at registration was not made' });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 40, userId: user.id });
    expect(JSON.stringify(logged[0])).not.toContain(user.email);
    expect(JSON.stringify(logged[0])).not.toContain('has space');
  });
});

// the whole way of a person, from the form to the profile
describe('the way of a person who ticks the box', () => {
  it('registers, presses the button of the page and finds the subscription', async () => {
    const mails = watchMail();
    const email = newEmail();
    const registered = await register({ email, newsletter: true });
    expect(registered.statusCode).toBe(201);

    // the page reads the hint from the link and shows the box ticked; the person keeps it
    const link: SentMail = mails.at(-1)!;
    const params = linkParams(link, PAGE)!;
    const ticked = params.get('newsletter') === '1';
    const res = await verify(params.get('token')!, ticked);

    expect(res.statusCode).toBe(200);
    expect(await rowsOf(email)).toEqual([
      expect.objectContaining({ source: 'account', status: 'active' }),
    ]);
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { emailHmacOf } from '@helpers/newsletterTokens.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { createUser, uniqueEmail } from '../../../helpers/factories.js';
import { mailedToken, watchNewsletterMail } from '../../../helpers/mail.js';
import {
  CONFIRM_PAGE,
  SUBSCRIPTIONS,
  errorAnswer,
  expireLink,
  forget,
  isBlocked,
  journalOf,
  liveRowOf,
  newsletterApi,
  passTheDay,
  rowsOf,
} from '../../../helpers/newsletterApi.js';
import { watchCaptcha, withCaptcha } from '../../../helpers/turnstile.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';

// The two buttons of the mail of a confirmation. The page of the frontend reads the token of the
// link and posts it here; opening the link alone changes nothing (a scanner of the mailbox does
// that), the action is the button. Both buttons carry the one token of the mail

let app: FastifyInstance;
let csrf: Csrf;
let api: ReturnType<typeof newsletterApi>;
const emails: string[] = [];

const CONFIRM = `${SUBSCRIPTIONS}/confirm`;
const DECLINE = `${SUBSCRIPTIONS}/decline`;

// a request of a guest and the token of the mail it brought
async function requested(locale = 'uk') {
  const email = uniqueEmail('confirm');
  emails.push(email);
  const mails = watchNewsletterMail();
  const res = await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale }));
  if (res.statusCode !== 202) throw new Error(`the request answered ${res.statusCode}`);

  return { email, token: mailedToken(mails, CONFIRM_PAGE) };
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  api = newsletterApi(app, csrf);
});

afterAll(async () => {
  try {
    await forget(emails);
  } finally {
    await stopApp();
  }
});

describe('POST /api/newsletters/subscriptions/confirm', () => {
  it('turns the request into a subscription in force, in the language it asked for', async () => {
    const { email, token } = await requested('uk');
    const calls = watchCaptcha();

    const res = await api.post(
      CONFIRM,
      { token },
      { from: '198.51.100.21', userAgent: 'mail-app/3' },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'active', locale: 'uk' });
    expect(calls).toHaveLength(0);

    const [row] = await rowsOf(email);
    expect(row).toMatchObject({
      status: 'active',
      source: 'form',
      confirmHash: null,
      confirmExpiresAt: null,
    });
    expect(row!.confirmedAt).not.toBeNull();
    expect(await journalOf(email)).toEqual([
      expect.objectContaining({ event: 'requested' }),
      expect.objectContaining({
        event: 'confirmed',
        place: 'form',
        ip: '198.51.100.21',
        userAgent: 'mail-app/3',
        locale: 'uk',
      }),
    ]);
  });

  it('works for a signed-in user as for a guest', async () => {
    const { email, token } = await requested('es');
    const user = await createUser();

    const res = await api.post(CONFIRM, { token }, { cookie: accessCookie(user) });

    expect(res.statusCode).toBe(200);
    expect((await rowsOf(email))[0]).toMatchObject({ status: 'active', userId: null });
  });

  it('takes a link once', async () => {
    const { email, token } = await requested();

    const first = await api.post(CONFIRM, { token });
    const second = await api.post(CONFIRM, { token });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
    expect(await rowsOf(email)).toHaveLength(1);
  });

  it('refuses a link past its three days', async () => {
    const { email, token } = await requested();
    await expireLink(email);

    const res = await api.post(CONFIRM, { token });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
    expect((await liveRowOf(email))?.status).toBe('pending');
  });

  it('refuses a link a newer mail replaced', async () => {
    const { email, token } = await requested();
    await passTheDay(email);
    await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }));

    const res = await api.post(CONFIRM, { token });

    expect(res.statusCode).toBe(400);
    expect((await liveRowOf(email))?.status).toBe('pending');
  });

  it('answers a link nobody was given and a link that is dead with one and the same refusal', async () => {
    const used = await requested();
    await api.post(CONFIRM, { token: used.token });
    const expired = await requested();
    await expireLink(expired.email);

    const answers = [];
    for (const token of [used.token, expired.token, 'a-token-nobody-was-given', 'x']) {
      answers.push(errorAnswer(await api.post(CONFIRM, { token })));
    }

    expect(answers[0]).toMatchObject({ status: 400, errorCode: 'NEWSLETTER_LINK_INVALID' });
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
  });

  it('takes the token from the body only', async () => {
    const { email, token } = await requested();

    const inQuery = await api.post(`${CONFIRM}?token=${encodeURIComponent(token)}`, undefined);
    const empty = await api.post(CONFIRM, { token: '' });
    const tooLong = await api.post(CONFIRM, { token: 'x'.repeat(513) });

    for (const res of [inQuery, empty, tooLong]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
    expect((await liveRowOf(email))?.status).toBe('pending');
  });

  it('is refused without the csrf token', async () => {
    const { token } = await requested();

    const res = await app.inject({ method: 'POST', url: CONFIRM, payload: { token } });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
  });

  it('lets the subscriber get the mail "you are already subscribed" afterwards, once a day', async () => {
    const { email, token } = await requested('es');
    await api.post(CONFIRM, { token });
    await passTheDay(email);
    const mails = watchNewsletterMail();

    await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }));

    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toEqual([email]);
    expect((await liveRowOf(email))?.status).toBe('active');
  });
});

describe('POST /api/newsletters/subscriptions/decline', () => {
  it('blocks the address for the form and removes the request with its journal', async () => {
    const { email, token } = await requested();

    const res = await api.post(DECLINE, { token });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ blocked: true });
    expect(await isBlocked(email)).toBe(true);
    expect(await rowsOf(email)).toEqual([]);
    expect(await journalOf(email)).toEqual([]);

    // the entry of the person keeps the HMAC of the address and who asked for it
    const [entry] = await inOwnerTx((db) =>
      db.rows<{ byPerson: boolean; blockedById: number | null }>(
        'select "byPerson", "blockedById" from cartlify.newsletter_form_blocklist where "emailHmac" = $1',
        emailHmacOf(email),
      ),
    );
    expect(entry).toEqual({ byPerson: true, blockedById: null });
  });

  // the person said "this is not me" about one spelling of the address: every spelling of the mailbox
  // stays blocked, a +tag does not undo it
  it('blocks the mailbox, not only the spelling the mail went to', async () => {
    const name = `decline-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const typed = `${name}+shop@shop.example.com`;
    emails.push(typed);
    const mails = watchNewsletterMail();
    await api.post(SUBSCRIPTIONS, withCaptcha({ email: typed, locale: 'uk' }));
    const token = mailedToken(mails, CONFIRM_PAGE);

    expect((await api.post(DECLINE, { token })).statusCode).toBe(200);

    expect(await isBlocked(`${name}@shop.example.com`)).toBe(true);
    const later = watchNewsletterMail();
    const again = await api.post(
      SUBSCRIPTIONS,
      withCaptcha({ email: `${name}+other@shop.example.com`, locale: 'uk' }),
    );
    emails.push(`${name}+other@shop.example.com`);
    expect(again.statusCode).toBe(202);
    expect(later).toEqual([]);
    expect(await rowsOf(`${name}+other@shop.example.com`)).toEqual([]);
  });

  it('kills the link of the confirmation with it', async () => {
    const { token } = await requested();

    await api.post(DECLINE, { token });
    const res = await api.post(CONFIRM, { token });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
  });

  it('is not repeated: the link works once', async () => {
    const { token } = await requested();

    const first = await api.post(DECLINE, { token });
    const second = await api.post(DECLINE, { token });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
  });

  it('stops the confirmation too: after the confirmation the same token does not block', async () => {
    const { email, token } = await requested();
    await api.post(CONFIRM, { token });

    const res = await api.post(DECLINE, { token });

    expect(res.statusCode).toBe(400);
    expect(await isBlocked(email)).toBe(false);
    expect((await liveRowOf(email))?.status).toBe('active');
  });

  it('refuses a link past its three days and blocks nothing', async () => {
    const { email, token } = await requested();
    await expireLink(email);

    const res = await api.post(DECLINE, { token });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
    expect(await isBlocked(email)).toBe(false);
  });

  it('answers a token nobody was given as it answers a dead link', async () => {
    const used = await requested();
    await api.post(DECLINE, { token: used.token });

    const a = errorAnswer(await api.post(DECLINE, { token: used.token }));
    const b = errorAnswer(await api.post(DECLINE, { token: 'a-token-nobody-was-given' }));

    expect(a).toEqual(b);
  });

  it('turns later requests of the form away without a mail, the answer staying the same', async () => {
    const { email, token } = await requested();
    await api.post(DECLINE, { token });
    await passTheDay(email);
    const mails = watchNewsletterMail();

    const res = await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }));

    expect(res.statusCode).toBe(202);
    expect(mails).toHaveLength(0);
    expect(await rowsOf(email)).toEqual([]);
  });

  it('turns away a signed-in user who asks about the address too, and lets the owner of it subscribe', async () => {
    const owner = await createUser();
    emails.push(owner.email);
    const mails = watchNewsletterMail();
    await api.post(SUBSCRIPTIONS, withCaptcha({ email: owner.email, locale: 'uk' }));
    const token = mailedToken(mails, CONFIRM_PAGE);
    await api.post(DECLINE, { token });
    const stranger = await createUser();

    const asked = await api.post(SUBSCRIPTIONS, withCaptcha({ email: owner.email, locale: 'uk' }), {
      cookie: accessCookie(stranger),
    });
    const own = await api.post(SUBSCRIPTIONS, {}, { cookie: accessCookie(owner) });

    expect(asked.statusCode).toBe(202);
    expect(mails).toHaveLength(1);
    expect(own.statusCode).toBe(201);
    expect(own.json()).toMatchObject({ source: 'account', status: 'active' });
  });

  it('is refused without the csrf token', async () => {
    const { token } = await requested();

    const res = await app.inject({ method: 'POST', url: DECLINE, payload: { token } });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
  });
});

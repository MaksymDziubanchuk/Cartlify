import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import {
  emailHmacOf,
  manageHashOf,
  manageTokenOf,
  unsubscribeTokenOf,
} from '@helpers/newsletterTokens.js';
import { hashToken } from '@helpers/tokenHash.js';
import { subscriptionMailsSent } from '@routes/api/newsletters/services/helpers/subscriptionMail.helper.js';
import { buildSubscriptionAlreadyTemplate } from '@services/email/templates/newsletters/subscriptionAlready.template.js';
import { buildSubscriptionConfirmTemplate } from '@services/email/templates/newsletters/subscriptionConfirm.template.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { createUser, uniqueEmail, type TestUser } from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import {
  answerNewsletterMail,
  breakSpamReportClearing,
  linkParts,
  linkToken,
  mailedToken,
  refuseMail,
  watchNewsletterMail,
  watchSpamReportClearing,
  type SentMail,
} from '../../../helpers/mail.js';
import {
  CONFIRM_PAGE,
  DECLINE_PAGE,
  MANAGE_PAGE,
  REQUEST_ANSWER,
  SUBSCRIPTIONS,
  arrange,
  blockAddress,
  databaseNow,
  errorAnswer,
  forget,
  isBlocked,
  journalOf,
  liveRowOf,
  newsletterApi,
  passTheDay,
  publicAnswer,
  rowsOf,
  setColumns,
} from '../../../helpers/newsletterApi.js';
import { DAY, near } from '../../../helpers/newsletterFns.js';
import { utc } from '../../../helpers/newsletterDb.js';
import {
  breakTurnstile,
  failCaptcha,
  spendCaptcha,
  watchCaptcha,
  withCaptcha,
} from '../../../helpers/turnstile.js';

// The form of the public page, POST /api/newsletters/subscriptions: a guest asks to subscribe an
// address (and a signed-in user asks about an address that is not their own) and gets one answer
// whatever the state of the address is; a signed-in user asks about their own address and is
// subscribed at once. The states of the database behind the answer are the tests of tests/integration/db

let app: FastifyInstance;
let csrf: Csrf;
let api: ReturnType<typeof newsletterApi>;
const emails: string[] = [];
let buyer: TestUser;

const fresh = (prefix = 'form') => {
  const email = uniqueEmail(prefix);
  emails.push(email);
  return email;
};

const subscribe = (body: Record<string, unknown>, opts: Parameters<typeof api.post>[2] = {}) =>
  api.post(SUBSCRIPTIONS, body, opts);

// the body of a request of a guest that is right in every part
const guestBody = (email: string, locale = 'uk') => withCaptcha({ email, locale });

const NOW_SHOP = () => shopSettings().shopName;

const confirmSubject = (locale: string) =>
  buildSubscriptionConfirmTemplate({
    confirmUrl: 'https://shop.example.com/a',
    declineUrl: 'https://shop.example.com/b',
    locale,
    appName: NOW_SHOP(),
  }).subject;

const alreadySubject = (locale: string, paused = false) =>
  buildSubscriptionAlreadyTemplate({
    manageUrl: 'https://shop.example.com/a',
    locale,
    appName: NOW_SHOP(),
    paused,
  }).subject;

// the mail of a confirmation: to the address, in the language, with both buttons on one token
function expectConfirmMail(mail: SentMail | undefined, email: string, locale: string): string {
  expect(mail).toMatchObject({
    stream: 'newsletter',
    to: [email],
    accepted: true,
    subject: confirmSubject(locale),
  });

  const token = linkToken(mail!, CONFIRM_PAGE);
  expect(token).toBeTruthy();
  expect(linkToken(mail!, DECLINE_PAGE)).toBe(token);
  // the token follows the # of both links and is in no query: no log of a host or a scanner has it
  for (const page of [CONFIRM_PAGE, DECLINE_PAGE]) {
    const parts = linkParts(mail!, page)!;
    expect([...parts.query]).toEqual([]);
    expect(parts.fragment.get('token')).toBe(token);
  }
  expect(mail!.html).not.toContain('?token=');
  expect(mail!.text).not.toContain('?token=');
  return token!;
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  api = newsletterApi(app, csrf);
  buyer = await createUser({ locale: 'uk' });
});

afterAll(async () => {
  try {
    await forget(emails);
  } finally {
    await stopApp();
  }
});

describe('POST /api/newsletters/subscriptions, a guest', () => {
  // the time of the answer must not tell what was mailed (a mail waits for the provider, no mail
  // does not): the answer comes while the mail is still on its way, and the mail follows
  it('answers before the provider has taken the mail, and the mail follows', async () => {
    const email = fresh();
    const mails = watchNewsletterMail();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    answerNewsletterMail(async () => {
      await held;
      return 202;
    });

    // straight to the app: the helpers of the tests wait for the mail of the form
    const res = await app.inject({
      method: 'POST',
      url: SUBSCRIPTIONS,
      headers: withCsrf(csrf, api.guest),
      payload: guestBody(email),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(REQUEST_ANSWER);
    expect(mails).toEqual([]);

    release();
    await subscriptionMailsSent();
    expect(mails).toHaveLength(1);
    expectConfirmMail(mails[0], email, 'uk');
  });

  it('accepts a new address, mails the confirmation in the language asked and keeps a request', async () => {
    const email = fresh();
    const mails = watchNewsletterMail();
    const calls = watchCaptcha();

    const res = await subscribe(guestBody(email, 'uk'), {
      from: '198.51.100.7',
      userAgent: 'form-browser/1.0',
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(REQUEST_ANSWER);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ remoteip: '198.51.100.7' });

    expect(mails).toHaveLength(1);
    const token = expectConfirmMail(mails[0], email, 'uk');

    const [row, ...others] = await rowsOf(email);
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      status: 'pending',
      source: 'form',
      locale: 'uk',
      userId: null,
      emailHmac: emailHmacOf(email),
      confirmHash: hashToken(token),
    });
    // the two links of the subscription are made from its salt, each with its own mark: the hash of
    // the token of the page of management and the hash of the token of the unsubscribe button
    expect(row!.manageHash).toBe(manageHashOf(manageTokenOf(row!.manageSalt)));
    expect(row!.unsubscribeHash).toBe(manageHashOf(unsubscribeTokenOf(row!.manageSalt)));
    expect(row!.unsubscribeHash).not.toBe(row!.manageHash);
    const now = await databaseNow();
    expect(near(row!.confirmExpiresAt, new Date(now.getTime() + 3 * DAY), 60_000)).toBe(true);

    expect(await journalOf(email)).toEqual([
      expect.objectContaining({
        event: 'requested',
        place: 'form',
        ip: '198.51.100.7',
        userAgent: 'form-browser/1.0',
        locale: 'uk',
      }),
    ]);
  });

  it('keeps the address in lower case, also in the mail', async () => {
    const email = fresh();
    const mails = watchNewsletterMail();

    const res = await subscribe(guestBody(email.toUpperCase(), 'en'));

    expect(res.statusCode).toBe(202);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toEqual([email]);
    expect(await rowsOf(email)).toHaveLength(1);
  });

  it('reads a locale with a region and a capital as the language it names', async () => {
    const email = fresh();
    const mails = watchNewsletterMail();

    await subscribe(guestBody(email, 'UK-ua'));

    expectConfirmMail(mails[0], email, 'uk');
    expect((await rowsOf(email))[0]!.locale).toBe('uk');
  });

  describe('a request the route refuses before it does anything', () => {
    // no mail, no row, no call to the captcha: the cheap checks come before the one that costs a call
    it.each<[string, () => Record<string, unknown>, string]>([
      ['no address', () => withCaptcha({ locale: 'en' }), 'EMAIL_REQUIRED'],
      // a null reads as an empty text, which is no address
      ['a null address', () => withCaptcha({ email: null, locale: 'en' }), 'VALIDATION_ERROR'],
      ['an empty address', () => withCaptcha({ email: '', locale: 'en' }), 'VALIDATION_ERROR'],
      [
        'a malformed address',
        () => withCaptcha({ email: 'not-an-email', locale: 'en' }),
        'VALIDATION_ERROR',
      ],
      [
        'an address over 254 characters',
        () => withCaptcha({ email: `${'a'.repeat(250)}@example.com`, locale: 'en' }),
        'VALIDATION_ERROR',
      ],
      ['no language', () => withCaptcha({ email: fresh() }), 'LOCALE_INVALID'],
      ['an empty language', () => withCaptcha({ email: fresh(), locale: '' }), 'LOCALE_INVALID'],
      ['a null language', () => withCaptcha({ email: fresh(), locale: null }), 'LOCALE_INVALID'],
      [
        'a language the shop does not answer in',
        () => withCaptcha({ email: fresh(), locale: 'fr' }),
        'LOCALE_INVALID',
      ],
      [
        'a language of the wrong shape',
        () => withCaptcha({ email: fresh(), locale: 'e1' }),
        'LOCALE_INVALID',
      ],
      [
        'a language over 35 characters',
        () => withCaptcha({ email: fresh(), locale: 'e'.repeat(36) }),
        'VALIDATION_ERROR',
      ],
    ])('refuses %s', async (_case, makeBody, errorCode) => {
      const body = makeBody();
      const mails = watchNewsletterMail();
      const calls = watchCaptcha();

      const res = await subscribe(body);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode });
      expect(calls).toHaveLength(0);
      expect(mails).toHaveLength(0);
      if (typeof body.email === 'string') expect(await rowsOf(body.email)).toEqual([]);
    });
  });

  describe('the captcha', () => {
    // a captcha that fails is checked before the route does anything: no row, no token, no mail
    it.each([
      ['is missing', () => undefined, 400, 'CAPTCHA_INVALID'],
      ['is refused', () => failCaptcha(), 400, 'CAPTCHA_INVALID'],
      ['was used before', () => spendCaptcha(), 400, 'CAPTCHA_INVALID'],
      ['cannot be checked', () => breakTurnstile('unreachable'), 503, 'CAPTCHA_UNAVAILABLE'],
    ])('that %s stops the request with nothing done', async (_case, spoil, status, errorCode) => {
      const email = fresh();
      const mails = watchNewsletterMail();
      const withoutAnswer = _case === 'is missing';
      spoil();

      const res = await subscribe(withoutAnswer ? { email, locale: 'en' } : guestBody(email, 'en'));

      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ errorCode });
      expect(mails).toHaveLength(0);
      expect(await rowsOf(email)).toEqual([]);

      if (status === 503) {
        expect(takeLogs({ msg: 'captcha could not be checked' })).toHaveLength(1);
        expect(takeLogs({ msg: 'request failed', errorCode: 'CAPTCHA_UNAVAILABLE' })).toHaveLength(
          1,
        );
      }
    });

    it('does not hold back a signed-in user who asks about another address either', async () => {
      const email = fresh();
      const mails = watchNewsletterMail();
      failCaptcha();

      const res = await subscribe(guestBody(email, 'en'), { cookie: accessCookie(buyer) });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'CAPTCHA_INVALID' });
      expect(mails).toHaveLength(0);
      expect(await rowsOf(email)).toEqual([]);
    });
  });

  // the answer says nothing about the address: not the state of it, not a blocklist, not a mail
  describe('one answer for every state of the address', () => {
    type State = {
      name: string;
      prepare: (email: string) => Promise<void>;
      // the mail the state calls for, in which language (the shop's own is known once the app is up)
      mail: {
        kind: 'confirm' | 'already';
        locale: string | (() => string);
        // the mail of a subscription a spam mark paused: it says so, and where to resume it
        paused?: boolean;
      } | null;
    };

    const HOUR = 3_600_000;

    const STATES: State[] = [
      {
        name: 'an address no one asked about',
        prepare: async () => {},
        mail: { kind: 'confirm', locale: 'uk' },
      },
      {
        name: 'a request that has waited since yesterday',
        prepare: async (email) => {
          await subscribe(guestBody(email, 'es'));
          await passTheDay(email);
        },
        mail: { kind: 'confirm', locale: 'uk' },
      },
      {
        name: 'a request made a moment ago',
        prepare: async (email) => {
          await subscribe(guestBody(email, 'es'));
        },
        mail: null,
      },
      {
        name: 'a subscription of the form in force',
        prepare: async (email) => {
          await arrange({ email, locale: 'es' });
        },
        mail: { kind: 'already', locale: 'es' },
      },
      {
        name: 'a subscription of the form in force that has no language',
        prepare: async (email) => {
          await arrange({ email, locale: null });
        },
        mail: { kind: 'already', locale: () => shopSettings().shopLocale },
      },
      {
        name: 'a subscription of the form mailed an hour ago',
        prepare: async (email) => {
          await arrange({ email, set: { lastAlreadyMailAt: utc(-HOUR) } });
        },
        mail: null,
      },
      {
        name: 'a subscription of an account',
        prepare: async (email) => {
          await arrange({ email, source: 'account', userId: buyer.id, locale: 'es' });
        },
        mail: null,
      },
      {
        name: 'a subscription paused by a complaint',
        prepare: async (email) => {
          await arrange({ email, status: 'paused_complaint', locale: 'es' });
        },
        mail: { kind: 'already', locale: 'es', paused: true },
      },
      {
        name: 'a blocked address',
        prepare: async (email) => blockAddress(email),
        mail: null,
      },
      {
        name: 'an address whose subscription ended',
        prepare: async (email) => {
          await arrange({ email, status: 'ended' });
        },
        mail: { kind: 'confirm', locale: 'uk' },
      },
      {
        name: 'an address a bounce stopped',
        prepare: async (email) => {
          await arrange({ email, status: 'stopped_bounce' });
        },
        mail: { kind: 'confirm', locale: 'uk' },
      },
    ];

    let reference: ReturnType<typeof publicAnswer>;

    beforeAll(async () => {
      reference = publicAnswer(await subscribe(guestBody(fresh(), 'uk')));
    });

    it('is 202 with the fixed message, with no cookie of its own', () => {
      expect(reference.status).toBe(202);
      expect(JSON.parse(reference.body)).toEqual(REQUEST_ANSWER);
      expect(reference.headers).not.toHaveProperty('set-cookie');
    });

    it.each(STATES)(
      'answers $name as it answers every other, and mails what it calls for',
      async ({ prepare, mail }) => {
        const email = fresh('state');
        await prepare(email);
        const mails = watchNewsletterMail();

        const res = await subscribe(guestBody(email, 'uk'));

        expect(publicAnswer(res)).toEqual(reference);

        if (!mail) {
          expect(mails).toHaveLength(0);
          return;
        }

        const locale = typeof mail.locale === 'function' ? mail.locale() : mail.locale;
        expect(mails).toHaveLength(1);
        if (mail.kind === 'confirm') {
          expectConfirmMail(mails[0], email, locale);
          return;
        }

        // "you are already subscribed": in the language of the subscription, with its manage link
        expect(mails[0]).toMatchObject({
          stream: 'newsletter',
          to: [email],
          accepted: true,
          subject: alreadySubject(locale, mail.paused === true),
        });
        expect(linkToken(mails[0]!, CONFIRM_PAGE)).toBeNull();
        const [row] = await rowsOf(email);
        expect(hashToken(mailedToken(mails, MANAGE_PAGE))).toBe(row!.manageHash);
        // the token of the page of management follows the # of the link, never its query
        const manage = linkParts(mails[0]!, MANAGE_PAGE)!;
        expect([...manage.query]).toEqual([]);
        expect(manage.fragment.get('token')).toBe(mailedToken(mails, MANAGE_PAGE));
      },
    );

    it('is the same when the mail cannot be sent, and says so in the log without the address', async () => {
      const kinds = [
        { email: fresh('refused'), prepare: async () => {} },
        {
          email: fresh('refused'),
          prepare: async (email: string) => {
            await arrange({ email });
          },
        },
      ];
      refuseMail('newsletter');

      for (const { email, prepare } of kinds) {
        await prepare(email);
        const res = await subscribe(guestBody(email, 'uk'));

        expect(publicAnswer(res)).toEqual(reference);
      }

      const logged = takeLogs({ msg: 'newsletter subscription mail was not sent' });
      expect(logged).toHaveLength(2);
      for (const entry of logged) {
        expect(entry).toMatchObject({ level: 40, reason: 'SENDGRID_SEND_FAILED' });
        for (const { email } of kinds) expect(JSON.stringify(entry)).not.toContain(email);
      }
    });
  });

  // A mail the provider did not take never reached the person, so it must not cost them their day:
  // the mark "mailed" that the form put on the address when it decided to mail it is taken back
  // (cartlify.newsletter_request_mail_failed), and the next request mails again
  describe('a mail that is not taken lifts the mark of the day', () => {
    // SendGrid refuses the first mail of the stream and takes the ones after it
    const refuseFirstMail = () =>
      answerNewsletterMail((_mail, index) => (index === 0 ? 400 : undefined));
    const takeRefusalLog = () => takeLogs({ msg: 'newsletter subscription mail was not sent' });

    it('lets a request mail again at once when the confirmation was refused', async () => {
      const email = fresh('lift');
      refuseFirstMail();

      const first = await subscribe(guestBody(email, 'uk'));
      takeRefusalLog();

      expect(first.statusCode).toBe(202);
      expect((await rowsOf(email))[0]!.lastConfirmMailAt).toBeNull();
      const mails = watchNewsletterMail();
      const second = await subscribe(guestBody(email, 'uk'));

      expect(second.statusCode).toBe(202);
      expect(mails).toHaveLength(1);
      expectConfirmMail(mails[0], email, 'uk');
      expect((await rowsOf(email))[0]!.lastConfirmMailAt).not.toBeNull();
    });

    it('lets a request mail again at once when "you are already subscribed" was refused', async () => {
      const email = fresh('lift');
      await arrange({ email, locale: 'en' });
      refuseFirstMail();

      await subscribe(guestBody(email, 'uk'));
      takeRefusalLog();

      expect((await rowsOf(email))[0]!.lastAlreadyMailAt).toBeNull();
      const mails = watchNewsletterMail();
      await subscribe(guestBody(email, 'uk'));

      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ subject: alreadySubject('en') });
      expect((await rowsOf(email))[0]!.lastAlreadyMailAt).not.toBeNull();
    });

    it('lifts the mark also when the server itself cannot build or send the mail', async () => {
      const email = fresh('lift');
      const sender = env.NEWSLETTER_EMAIL_FROM;
      env.NEWSLETTER_EMAIL_FROM = '';

      try {
        await subscribe(guestBody(email, 'uk'));
      } finally {
        env.NEWSLETTER_EMAIL_FROM = sender;
      }
      takeLogs({ msg: 'newsletter subscription mail could not be built or sent' });

      expect((await rowsOf(email))[0]!.lastConfirmMailAt).toBeNull();
    });

    it('keeps the mark when the provider takes the mail', async () => {
      const email = fresh('lift');

      await subscribe(guestBody(email, 'uk'));

      expect((await rowsOf(email))[0]!.lastConfirmMailAt).not.toBeNull();
      const mails = watchNewsletterMail();
      await subscribe(guestBody(email, 'uk'));
      expect(mails).toHaveLength(0);
    });

    it('takes back only the mark of the mail that failed', async () => {
      const email = fresh('lift');
      await arrange({ email, locale: 'en', set: { lastConfirmMailAt: utc(-60_000) } });
      refuseFirstMail();

      await subscribe(guestBody(email, 'uk'));
      takeRefusalLog();

      // the confirmation went a minute ago and stays marked; the "already" mail that failed is lifted
      const [row] = await rowsOf(email);
      expect(row!.lastConfirmMailAt).not.toBeNull();
      expect(row!.lastAlreadyMailAt).toBeNull();
    });

    it('answers as it does for a mail that went', async () => {
      const reference = publicAnswer(await subscribe(guestBody(fresh('lift'), 'uk')));
      refuseFirstMail();

      const refused = publicAnswer(await subscribe(guestBody(fresh('lift'), 'uk')));
      takeRefusalLog();

      expect(refused).toEqual(reference);
    });
  });

  // A subscription a spam mark paused (paused_complaint): the provider drops every mail to an address
  // on its list of spam reports, so the form takes the address off the list of the newsletter account
  // first, and only then mails the person what happened and where to resume
  describe('a subscription paused by a spam mark', () => {
    const pausedRow = async (locale = 'uk') => {
      const email = fresh('paused');
      await arrange({ email, status: 'paused_complaint', locale });
      return email;
    };
    const takeClearingLog = () =>
      takeLogs({ msg: 'spam report of the newsletter account was not cleared' });

    it('takes the address off the list of spam reports and only then sends the mail of the pause', async () => {
      const email = await pausedRow('uk');
      const cleared = watchSpamReportClearing();
      const seenAtSend: number[] = [];
      answerNewsletterMail(() => {
        seenAtSend.push(cleared.length);
        return undefined;
      });
      const mails = watchNewsletterMail();

      const res = await subscribe(guestBody(email, 'en'));

      expect(res.statusCode).toBe(202);
      expect(cleared).toEqual([{ email, stream: 'newsletter', status: 204 }]);
      // by the time the mail reached the provider the removal was done
      expect(seenAtSend).toEqual([1]);
      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({
        stream: 'newsletter',
        to: [email],
        accepted: true,
        subject: alreadySubject('uk', true),
      });
      expect(mails[0]!.text).toContain('призупинено після позначки «спам»');
      const [row] = await rowsOf(email);
      expect(hashToken(mailedToken(mails, MANAGE_PAGE))).toBe(row!.manageHash);
      // the subscription itself stays paused: only the person resumes it
      expect(row).toMatchObject({ status: 'paused_complaint' });
    });

    it('writes the mail of the pause in the language of the subscription', async () => {
      const mails = watchNewsletterMail();
      const email = await pausedRow('es');

      await subscribe(guestBody(email, 'uk'));

      expect(mails[0]).toMatchObject({ subject: alreadySubject('es', true) });
      expect(mails[0]!.text).toContain('está en pausa tras una marca de spam');
    });

    it('does not touch the list for a subscription in force, a request that waits or a mail not due', async () => {
      const cleared = watchSpamReportClearing();
      const inForce = fresh('paused');
      await arrange({ email: inForce, locale: 'en' });
      const waiting = fresh('paused');
      await arrange({ email: waiting, status: 'pending' });
      await setColumns(waiting, { lastConfirmMailAt: utc(-3_600_000) });
      const mailedToday = await pausedRow('en');
      await setColumns(mailedToday, { lastAlreadyMailAt: utc(-3_600_000) });
      const mails = watchNewsletterMail();

      await subscribe(guestBody(inForce, 'uk'));
      await subscribe(guestBody(waiting, 'uk'));
      await subscribe(guestBody(mailedToday, 'uk'));

      expect(cleared).toEqual([]);
      expect(mails.map((mail) => mail.to[0])).toEqual([inForce]);
    });

    it('is answered as every other state, whether the list answers or not', async () => {
      const reference = publicAnswer(await subscribe(guestBody(fresh('paused'), 'uk')));

      for (const broken of [undefined, 'refused', 'unreachable'] as const) {
        const email = await pausedRow('uk');
        if (broken) breakSpamReportClearing(broken);

        const res = await subscribe(guestBody(email, 'uk'));

        expect(publicAnswer(res)).toEqual(reference);
      }
      takeClearingLog();
    });

    // the list is for the provider to drop mails with; the mail of the pause is worth sending even
    // when the removal failed, the person can resume the subscription on its page all the same
    it.each(['refused', 'unreachable'] as const)(
      'sends the mail all the same when the list is %s, and only logs it without the address',
      async (broken) => {
        const email = await pausedRow('uk');
        breakSpamReportClearing(broken);
        const mails = watchNewsletterMail();

        const res = await subscribe(guestBody(email, 'uk'));

        expect(res.statusCode).toBe(202);
        expect(mails).toHaveLength(1);
        expect(mails[0]).toMatchObject({ subject: alreadySubject('uk', true) });
        const logged = takeClearingLog();
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ level: 40 });
        expect(JSON.stringify(logged)).not.toContain(email);
      },
    );

    it('lifts the mark of the day when the mail of the pause is not taken, and asks the list again next time', async () => {
      const email = await pausedRow('uk');
      const cleared = watchSpamReportClearing();
      answerNewsletterMail((_mail, index) => (index === 0 ? 400 : undefined));

      await subscribe(guestBody(email, 'uk'));
      takeLogs({ msg: 'newsletter subscription mail was not sent' });
      expect((await rowsOf(email))[0]!.lastAlreadyMailAt).toBeNull();

      const mails = watchNewsletterMail();
      await subscribe(guestBody(email, 'uk'));

      expect(cleared).toHaveLength(2);
      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ subject: alreadySubject('uk', true) });
    });
  });

  describe('a server that cannot build the mail', () => {
    // a fault of the server (no sender set) must not show in the answer either: a 500 would be given
    // only to an address a mail is due to
    it('answers as it always does and logs an error without the address', async () => {
      const reference = publicAnswer(await subscribe(guestBody(fresh(), 'uk')));
      const email = fresh();
      const mails = watchNewsletterMail();
      const sender = env.NEWSLETTER_EMAIL_FROM;
      env.NEWSLETTER_EMAIL_FROM = '';

      let res;
      try {
        res = await subscribe(guestBody(email, 'uk'));
      } finally {
        env.NEWSLETTER_EMAIL_FROM = sender;
      }

      expect(publicAnswer(res)).toEqual(reference);
      expect(mails).toHaveLength(0);
      expect(await rowsOf(email)).toHaveLength(1);
      const logged = takeLogs({ msg: 'newsletter subscription mail could not be built or sent' });
      expect(logged).toHaveLength(1);
      expect(JSON.stringify(logged)).not.toContain(email);
    });
  });

  describe('a mail once a day to an address', () => {
    it('sends no second mail to a request that asks again at once, and one again after the day', async () => {
      const email = fresh();
      const mails = watchNewsletterMail();

      const first = publicAnswer(await subscribe(guestBody(email, 'uk')));
      const second = publicAnswer(await subscribe(guestBody(email, 'uk')));

      expect(second).toEqual(first);
      expect(mails).toHaveLength(1);

      await passTheDay(email);
      const third = publicAnswer(await subscribe(guestBody(email, 'uk')));

      expect(third).toEqual(first);
      expect(mails).toHaveLength(2);
      expectConfirmMail(mails[1], email, 'uk');
    });

    it('counts the day over both kinds of mail', async () => {
      const email = fresh();
      await arrange({ email, locale: 'en' });
      const mails = watchNewsletterMail();

      await subscribe(guestBody(email, 'uk'));
      await subscribe(guestBody(email, 'uk'));

      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ subject: alreadySubject('en') });
    });
  });

  describe('a new link for a request that waits', () => {
    it('kills the old link, starts the three days again and takes the language of the new request', async () => {
      const email = fresh();
      const mails = watchNewsletterMail();
      await subscribe(guestBody(email, 'es'));
      const oldToken = expectConfirmMail(mails[0], email, 'es');
      await passTheDay(email);
      await setColumns(email, { confirmExpiresAt: utc(DAY) });

      await subscribe(guestBody(email, 'uk'));

      expect(mails).toHaveLength(2);
      const newToken = expectConfirmMail(mails[1], email, 'uk');
      expect(newToken).not.toBe(oldToken);
      const row = await liveRowOf(email);
      const now = await databaseNow();
      expect(near(row!.confirmExpiresAt, new Date(now.getTime() + 3 * DAY), 60_000)).toBe(true);
      expect(row).toMatchObject({ locale: 'uk', confirmHash: hashToken(newToken) });

      const dead = await api.post(`${SUBSCRIPTIONS}/confirm`, { token: oldToken });
      expect(dead.statusCode).toBe(400);
      expect(dead.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });

      const live = await api.post(`${SUBSCRIPTIONS}/confirm`, { token: newToken });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toMatchObject({ status: 'active', locale: 'uk' });
    });
  });

  describe('a blocked address', () => {
    it('gets the answer and no mail, and no request is kept for it', async () => {
      const email = fresh();
      await blockAddress(email);
      const mails = watchNewsletterMail();

      const res = await subscribe(guestBody(email, 'uk'));

      expect(res.statusCode).toBe(202);
      expect(mails).toHaveLength(0);
      expect(await rowsOf(email)).toEqual([]);
      expect(await isBlocked(email)).toBe(true);
    });
  });

  describe('a signed-in user who asks about another address', () => {
    // The language of an account is the language of its owner, not of the person whose address this
    // is: the mail goes in the language the request asks for, as it does for a guest
    it.each(['USER', 'ADMIN', 'ROOT'] as const)(
      'is answered as a guest, in the language asked and not in their own: %s',
      async (role) => {
        const user = await createUser({ role, locale: 'uk' });
        const email = fresh();
        const mails = watchNewsletterMail();
        const calls = watchCaptcha();

        const res = await subscribe(withCaptcha({ email, locale: 'es' }), {
          cookie: accessCookie(user),
        });

        expect(res.statusCode).toBe(202);
        expect(res.json()).toEqual(REQUEST_ANSWER);
        expect(calls).toHaveLength(1);
        expectConfirmMail(mails[0], email, 'es');
        expect((await rowsOf(email))[0]).toMatchObject({
          source: 'form',
          userId: null,
          locale: 'es',
        });
      },
    );

    it.each([
      ['an account with a language', 'uk'],
      ['an account with none', undefined],
    ])('must name a language, as a guest must: %s', async (_case, accountLocale) => {
      const user = await createUser(accountLocale ? { locale: accountLocale } : {});
      const email = fresh();
      const mails = watchNewsletterMail();
      const calls = watchCaptcha();

      const none = await subscribe(withCaptcha({ email }), { cookie: accessCookie(user) });
      const empty = await subscribe(withCaptcha({ email, locale: '' }), {
        cookie: accessCookie(user),
      });

      for (const res of [none, empty]) {
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ errorCode: 'LOCALE_INVALID' });
      }
      // refused before the captcha is asked and before anything is written or mailed
      expect(calls).toHaveLength(0);
      expect(mails).toHaveLength(0);
      expect(await rowsOf(email)).toEqual([]);
    });

    it('may leave the language out for their own address, which the account answers', async () => {
      const user = await createUser({ locale: 'uk' });
      emails.push(user.email);

      const res = await subscribe({ email: user.email }, { cookie: accessCookie(user) });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ source: 'account', locale: 'uk' });
    });

    it('is refused a language the shop does not answer in, with nothing done', async () => {
      const user = await createUser();
      const email = fresh();
      const mails = watchNewsletterMail();

      const res = await subscribe(withCaptcha({ email, locale: 'fr' }), {
        cookie: accessCookie(user),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'LOCALE_INVALID' });
      expect(mails).toHaveLength(0);
      expect(await rowsOf(email)).toEqual([]);
    });

    it('is answered the same when the address is the one of another account that subscribed', async () => {
      const other = await createUser();
      await arrange({ email: other.email, source: 'account', userId: other.id });
      emails.push(other.email);
      const mails = watchNewsletterMail();

      const res = await subscribe(withCaptcha({ email: other.email, locale: 'en' }), {
        cookie: accessCookie(buyer),
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(REQUEST_ANSWER);
      expect(mails).toHaveLength(0);
    });

    it('is asked for the captcha even when their own account has not verified its address', async () => {
      const user = await createUser({ isVerified: false });
      const email = fresh();
      const mails = watchNewsletterMail();

      const without = await subscribe({ email, locale: 'en' }, { cookie: accessCookie(user) });
      const with_ = await subscribe(guestBody(email, 'en'), { cookie: accessCookie(user) });

      expect(without.statusCode).toBe(400);
      expect(without.json()).toMatchObject({ errorCode: 'CAPTCHA_INVALID' });
      expect(with_.statusCode).toBe(202);
      expect(mails).toHaveLength(1);
    });
  });
});

describe('POST /api/newsletters/subscriptions, a signed-in user for their own address', () => {
  const OWN_STATE = {
    subscribed: true,
    source: 'account',
    status: 'active',
    canChangeLocale: true,
  };

  it.each([
    ['USER', 'no address', undefined],
    ['USER', 'their own address in capitals', 'UPPER'],
    ['ADMIN', 'no address', undefined],
    ['ROOT', 'no address', undefined],
  ] as const)(
    'subscribes %s at once with %s, with no captcha and no mail',
    async (role, _case, form) => {
      const user = await createUser({ role, locale: 'es' });
      emails.push(user.email);
      const mails = watchNewsletterMail();
      const calls = watchCaptcha();
      // a captcha that would fail is never asked
      failCaptcha();

      const res = await subscribe(form === 'UPPER' ? { email: user.email.toUpperCase() } : {}, {
        cookie: accessCookie(user),
        from: '198.51.100.9',
        userAgent: 'profile-browser/2.0',
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        ...OWN_STATE,
        locale: 'es',
        subscribedAt: expect.any(String),
      });
      expect(calls).toHaveLength(0);
      expect(mails).toHaveLength(0);

      const [row] = await rowsOf(user.email);
      expect(row).toMatchObject({
        source: 'account',
        status: 'active',
        userId: user.id,
        locale: 'es',
        emailHmac: null,
      });
      expect(row!.manageHash).toBe(manageHashOf(manageTokenOf(row!.manageSalt)));
      expect(row!.unsubscribeHash).toBe(manageHashOf(unsubscribeTokenOf(row!.manageSalt)));
      expect(await journalOf(user.email)).toEqual([
        expect.objectContaining({
          event: 'subscribed',
          place: 'profile',
          ip: '198.51.100.9',
          userAgent: 'profile-browser/2.0',
        }),
      ]);
    },
  );

  it('takes the language asked, then the one of the account, then none', async () => {
    const withLocale = await createUser({ locale: 'uk' });
    const without = await createUser();
    const asking = await createUser({ locale: 'uk' });
    emails.push(withLocale.email, without.email, asking.email);

    const own = await subscribe({}, { cookie: accessCookie(withLocale) });
    const none = await subscribe({}, { cookie: accessCookie(without) });
    const asked = await subscribe({ locale: 'es' }, { cookie: accessCookie(asking) });

    expect(own.json()).toMatchObject({ locale: 'uk' });
    expect(none.json()).toMatchObject({ locale: null });
    expect(asked.json()).toMatchObject({ locale: 'es' });
  });

  it('keeps no language of the account that the shop stopped answering in', async () => {
    const user = await createUser({ locale: 'fr' });
    emails.push(user.email);

    const res = await subscribe({}, { cookie: accessCookie(user) });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ locale: null });
  });

  it('takes a request with no body at all, every field of it being optional', async () => {
    const user = await createUser();
    emails.push(user.email);

    const res = await api.post(SUBSCRIPTIONS, undefined, { cookie: accessCookie(user) });
    const guest = await api.post(SUBSCRIPTIONS, undefined);

    expect(res.statusCode).toBe(201);
    expect(guest.statusCode).toBe(400);
    expect(guest.json()).toMatchObject({ errorCode: 'EMAIL_REQUIRED' });
  });

  it('refuses a language the shop does not answer in, with no row', async () => {
    const user = await createUser();
    emails.push(user.email);

    const res = await subscribe({ locale: 'fr' }, { cookie: accessCookie(user) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'LOCALE_INVALID' });
    expect(await rowsOf(user.email)).toEqual([]);
  });

  it('refuses a second subscription with 409, whoever made the first', async () => {
    const own = await createUser();
    const viaForm = await createUser();
    emails.push(own.email, viaForm.email);
    await arrange({ email: viaForm.email, locale: 'en' });
    const mails = watchNewsletterMail();

    await subscribe({}, { cookie: accessCookie(own) });
    const again = await subscribe({}, { cookie: accessCookie(own) });
    const formOne = await subscribe({}, { cookie: accessCookie(viaForm) });

    for (const res of [again, formOne]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_ALREADY_SUBSCRIBED' });
    }
    expect(await rowsOf(own.email)).toHaveLength(1);
    expect((await rowsOf(viaForm.email))[0]).toMatchObject({ source: 'form' });
    expect(mails).toHaveLength(0);
  });

  it('turns a request of the form that waits on the address into the subscription of the account', async () => {
    const user = await createUser({ locale: 'uk' });
    emails.push(user.email);
    const waiting = await arrange({ email: user.email, status: 'pending', locale: 'es' });

    const res = await subscribe({}, { cookie: accessCookie(user) });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ source: 'account', status: 'active', locale: 'uk' });
    const rows = await rowsOf(user.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: waiting.id, source: 'account', userId: user.id });

    // the link of the request that waited is dead now
    const dead = await api.post(`${SUBSCRIPTIONS}/confirm`, { token: waiting.confirmToken! });
    expect(dead.statusCode).toBe(400);
  });

  it('works for an address on the blocklist, which is for the form only', async () => {
    const user = await createUser();
    emails.push(user.email);
    await blockAddress(user.email);

    const res = await subscribe({}, { cookie: accessCookie(user) });

    expect(res.statusCode).toBe(201);
  });

  it('refuses an account that has not verified its address with 403, and writes nothing', async () => {
    const user = await createUser({ isVerified: false });
    emails.push(user.email);
    const calls = watchCaptcha();

    const res = await subscribe({}, { cookie: accessCookie(user) });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_EMAIL_NOT_VERIFIED' });
    expect(calls).toHaveLength(0);
    expect(await rowsOf(user.email)).toEqual([]);
  });

  it('subscribes again after the person unsubscribed in the profile, in a new row', async () => {
    const user = await createUser();
    emails.push(user.email);
    const cookie = accessCookie(user);

    await subscribe({}, { cookie });
    await api.delete(`${'/api/newsletters'}/me`, { cookie });
    const again = await subscribe({}, { cookie });

    expect(again.statusCode).toBe(201);
    const rows = await rowsOf(user.email);
    expect(rows.map((row) => row.status)).toEqual(['ended', 'active']);
  });
});

describe('two requests at once for one address', () => {
  it('send one mail and keep one request', async () => {
    const email = fresh();
    const mails = watchNewsletterMail();

    const answers = await Promise.all([
      subscribe(guestBody(email, 'uk')),
      subscribe(guestBody(email, 'uk')),
      subscribe(guestBody(email, 'uk')),
    ]);

    expect(answers.map((res) => res.statusCode)).toEqual([202, 202, 202]);
    expect(new Set(answers.map((res) => res.body)).size).toBe(1);
    expect(mails).toHaveLength(1);
    expect(await rowsOf(email)).toHaveLength(1);
  });
});

describe('the csrf token', () => {
  it('is needed by the form, as by every route that changes data', async () => {
    const email = fresh();
    const mails = watchNewsletterMail();

    const res = await app.inject({
      method: 'POST',
      url: SUBSCRIPTIONS,
      payload: guestBody(email, 'uk'),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
    expect(mails).toHaveLength(0);
    expect(await rowsOf(email)).toEqual([]);
  });
});

describe('the answer of a refusal', () => {
  it('does not tell an address with a subscription from one without by a refusal of its own', async () => {
    const known = fresh();
    await arrange({ email: known });
    const unknown = fresh();

    // the same wrong request about both: the same refusal
    const a = await subscribe({ email: known, locale: 'xx', captchaToken: 'x' });
    const b = await subscribe({ email: unknown, locale: 'xx', captchaToken: 'x' });

    expect(errorAnswer(a)).toEqual(errorAnswer(b));
  });
});

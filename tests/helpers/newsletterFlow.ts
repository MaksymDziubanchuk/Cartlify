import type { FastifyInstance } from 'fastify';
import { expect } from '@jest/globals';

import {
  runNewsletterPass,
  type NewsletterPassOptions,
  type NewsletterPassSummary,
} from '../../src/jobs/newsletterPass.job.js';
import { logIn, type Session } from './actors.js';
import { cookieJar } from './cookies.js';
import type { Csrf } from './csrf.js';
import { mailedToken, watchNewsletterMail, type SentMail } from './mail.js';
import { BASE, CONFIRM_PAGE, MANAGE_PAGE, SUBSCRIPTIONS, newsletterApi } from './newsletterApi.js';
import { mailEvent } from './newsletterWebhook.js';
import { withCaptcha } from './turnstile.js';

// What the flows of the newsletters (tests/integration/flows/newsletter*) share: a campaign launched
// the way the people who run the newsletters launch one and the sending that follows, and what the
// reader of a mail does with it (opens the link, presses the button of the mail client, marks the mail
// as spam). The flows judge what the people see, so everything here goes through the routes, the
// mails and the pass of the sending; the database is for the end of a flow only

export type Locale = 'en' | 'es' | 'uk';

// the subject of a campaign in a language, so a test knows which one a reader got
export const subjectOf = (locale: Locale, tag: string): string =>
  ({ en: `Sale ${tag}`, es: `Rebajas ${tag}`, uk: `Sale ${tag} for uk` })[locale];

// the text of the first block of a campaign in a language
export const greetingOf = (locale: Locale, tag: string): string =>
  ({ en: `Hello ${tag}`, es: `Hola ${tag}`, uk: `Hello ${tag} for uk` })[locale];

// a campaign that is whole in every language the shop answers in
export const campaignContent = (tag: string) => ({
  subject: { en: subjectOf('en', tag), es: subjectOf('es', tag), uk: subjectOf('uk', tag) },
  preview: { en: 'The best prices' },
  blocks: [
    {
      type: 'text',
      text: { en: greetingOf('en', tag), es: greetingOf('es', tag), uk: greetingOf('uk', tag) },
    },
    { type: 'button', kind: 'sale', url: '/sale' },
  ],
});

// A campaign that went out: its id, the mails the sending made for it and what the pass reported
export type Launched = {
  id: number;
  mails: SentMail[];
  summary: NewsletterPassSummary;
  // the mails of the campaign to one address
  to: (email: string) => SentMail[];
};

// One person who runs the newsletters, signed in (the cookie of the session), and the campaigns they
// launch. Every campaign is made and scheduled with the routes of the managers, for a day of its own
// far from the real calendar (a year drawn for the file, a campaign every three weeks), so the limit
// of campaigns of the shop never holds one back, and the pass is told that day: it starts the
// campaign, mails the audience and finishes it. The pass is narrowed to the campaign it launches and
// its daily limit is out of the way. A flow that writes, tests and schedules the campaign by hand asks
// the desk for the next day (slot) and lets the pass send what is planned for it (pass, with a daily
// limit of its own when the sending is to stop half way). A campaign starts with a mail for every
// subscription in force in the database, so the file that launches one is *.shopwide, and the flows
// judge the mails of their own readers
export function newsletterDesk(app: FastifyInstance, csrf: Csrf, cookie: string) {
  const api = newsletterApi(app, csrf);
  // above the years the tests of the schedule and the pass draw theirs from (2100 to about 8200), so
  // no campaign of another file ever stands in a window of the limit beside these
  const year = 8300 + Math.floor(Math.random() * 1500);
  let launches = 0;
  const lines: { level: string; fields: unknown; msg: string }[] = [];

  // what the pass logs: a warning or an error nobody expected fails the flow (problems)
  const log = Object.fromEntries(
    (['info', 'warn', 'error'] as const).map((level) => [
      level,
      (first: unknown, second?: string) => {
        lines.push(
          typeof first === 'string'
            ? { level, fields: {}, msg: first }
            : { level, fields: first, msg: second ?? '' },
        );
      },
    ]),
  ) as unknown as NewsletterPassOptions['log'];

  const get = (url: string) => api.get(url, { cookie });

  // the day of the next campaign of this desk: its own year, three weeks after the one before
  const nextSlot = (): Date => new Date(Date.UTC(year, 5, 1 + 21 * launches++, 12, 0, 0));

  // The pass told it is the hour after `at`, narrowed to the campaigns named, with the daily limit
  // given (out of the way unless a flow wants the sending to stop half way). Returns what the pass
  // reported and the mails it sent for those campaigns
  async function pass(ids: number[], at: Date, opts: { dailyLimit?: number } = {}) {
    const sent = watchNewsletterMail();
    const summary = await runNewsletterPass({
      log,
      now: new Date(at.getTime() + 3_600_000),
      pauseMs: 0,
      campaignIds: ids,
      dailyLimit: opts.dailyLimit ?? 1_000_000,
    });

    return {
      summary,
      mails: sent.filter((mail) => ids.includes(Number(mail.customArgs.campaignId))),
    };
  }

  return {
    // The next day for a campaign of this desk (a campaign planned for it is far from the limit of
    // the campaigns of every other file) and the pass for the campaigns planned for a day
    slot: nextSlot,
    pass,

    // makes a campaign with the text given, schedules it and lets the pass send it
    async launch(
      tag: string,
      content: Record<string, unknown> = campaignContent(tag),
    ): Promise<Launched> {
      const at = nextSlot();

      const made = await api.post(
        `${BASE}/campaigns`,
        { name: `Flow ${tag} ${year}`, missingLocale: 'shop_locale', content },
        { cookie },
      );
      expect(made.statusCode).toBe(201);
      const id = made.json().id as number;

      const scheduled = await api.post(
        `${BASE}/campaigns/${id}/schedule`,
        { scheduledAt: at.toISOString() },
        { cookie },
      );
      expect(scheduled.statusCode).toBe(200);
      expect(scheduled.json()).toMatchObject({ id, status: 'scheduled' });

      const { summary, mails } = await pass([id], at);
      expect(summary).toMatchObject({ reason: 'done', launched: 1, rejected: 0 });

      return {
        id,
        mails,
        summary,
        to: (email: string) => mails.filter((mail) => mail.to[0] === email),
      };
    },

    // the campaign as the manager reads it
    async campaign(id: number) {
      const res = await get(`${BASE}/campaigns/${id}`);
      expect(res.statusCode).toBe(200);
      return res.json() as {
        status: string;
        counters: {
          planned: number;
          sent: number;
          rejected: number;
          undelivered: number;
          complaints: number;
          unsubscribed: number;
        };
      };
    },

    // the subscriptions of an address as the manager finds them, the oldest first
    async subscribers(email: string) {
      const res = await get(`${BASE}/subscribers?email=${encodeURIComponent(email)}`);
      expect(res.statusCode).toBe(200);
      return (
        res.json().items as {
          id: number;
          source: string;
          locale: string | null;
          status: string;
          userId: number | null;
          endReason: string | null;
        }[]
      ).sort((a, b) => a.id - b.id);
    },

    // the warnings and the errors the pass logged
    problems: () => lines.filter((line) => line.level !== 'info'),
  };
}

// A person asks for the newsletter on the public form with the address, reads the mail and confirms
// it with the link of that mail. Returns the mail that asked for the confirmation
export async function subscribeOnPage(
  app: FastifyInstance,
  csrf: Csrf,
  email: string,
  locale: Locale,
): Promise<SentMail> {
  const api = newsletterApi(app, csrf);
  const mails = watchNewsletterMail();

  const asked = await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale }));
  expect(asked.statusCode).toBe(202);

  const asking = mails.filter((mail) => mail.to[0] === email);
  expect(asking).toHaveLength(1);
  const confirmed = await api.post(`${SUBSCRIPTIONS}/confirm`, {
    token: mailedToken(asking, CONFIRM_PAGE),
  });
  expect(confirmed.statusCode).toBe(200);
  expect(confirmed.json()).toEqual({ status: 'active', locale });

  return asking[0]!;
}

// What a new buyer accepts when the shop has terms or a contract in force: the versions the form of
// the registration and the page of login show (GET /api/legal/documents/current). A file after
// legal.shopwide meets such a shop (a published version cannot be taken back), and registration, login
// and a first login with a provider all refuse a person who does not accept them. Nothing to accept
// while root has published none
export async function documentsToAccept(app: FastifyInstance): Promise<number[]> {
  const res = await app.inject({ method: 'GET', url: '/api/legal/documents/current' });
  expect(res.statusCode).toBe(200);

  return (res.json().items as { id: number; kind: string }[])
    .filter((document) => document.kind !== 'privacy')
    .map((document) => document.id);
}

// the field of a body that carries the acceptance, none when there is nothing to accept
export const accepting = (ids: number[]): { acceptedDocumentIds?: number[] } =>
  ids.length ? { acceptedDocumentIds: ids } : {};

// A buyer logs in with the password, accepting what is in force the way the page of login shows it
export async function signInAccepting(
  app: FastifyInstance,
  csrf: Csrf,
  user: { email: string; password: string },
): Promise<Session> {
  const res = await logIn(app, csrf, {
    email: user.email,
    password: user.password,
    ...accepting(await documentsToAccept(app)),
  });
  if (res.statusCode !== 200) throw new Error(`login of ${user.email} answered ${res.statusCode}`);

  const jar = cookieJar(res);
  return { accessToken: jar.accessToken!, refreshToken: jar.refreshToken! };
}

// the token of the link "Manage the subscription" in a mail of a campaign
export const manageTokenOf = (mail: SentMail): string => mailedToken([mail], MANAGE_PAGE);

// The button of unsubscribing in the mail client: it posts the form named by List-Unsubscribe-Post to
// the address named by List-Unsubscribe, with no cookie and no csrf token, and takes any 2xx as done
export function pressUnsubscribe(app: FastifyInstance, mail: SentMail) {
  const header = mail.headers['List-Unsubscribe'] ?? '';
  const address = /^<(https?:\/\/[^>]+)>$/.exec(header)?.[1];
  if (!address) throw new Error('the mail has no address to unsubscribe at');

  const url = new URL(address);
  return app.inject({
    method: 'POST',
    url: `${url.pathname}${url.search}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: mail.headers['List-Unsubscribe-Post'] ?? '',
  });
}

// What SendGrid reports about a mail it took: an event of the kind (bounce, spamreport, dropped) that
// names the mail the way SendGrid does, by the address, the id it gave and the custom arguments the
// mail carried
export function reportOf(mail: SentMail, event: 'bounce' | 'spamreport' | 'dropped') {
  expect(mail.messageId).not.toBeNull();

  return mailEvent(event, null, {
    email: mail.to[0],
    sg_message_id: `${mail.messageId}.filter0001.1.0`,
    ...mail.customArgs,
  });
}

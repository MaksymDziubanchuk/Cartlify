import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { sessionCookie, signIn } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { uniqueEmail } from '../../helpers/factories.js';
import { dictionaryText } from '../../helpers/dictionary.js';
import { mailedToken, watchNewsletterMail } from '../../helpers/mail.js';
import {
  BASE,
  CONFIRM_PAGE,
  REQUEST_ANSWER,
  SUBSCRIPTIONS,
  forget,
  journalOf,
  newsletterApi,
} from '../../helpers/newsletterApi.js';
import {
  countOf,
  greetingOf,
  manageTokenOf,
  newsletterDesk,
  pressUnsubscribe,
  subjectOf,
  subscribeOnPage,
} from '../../helpers/newsletterFlow.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../helpers/newsletterStaff.js';
import { withCaptcha } from '../../helpers/turnstile.js';

// A guest and the newsletter, each step with what the guest sees. Maria fills in the form of the page
// of the shop, finds the mail in her mailbox and confirms with its link; the people who run the
// newsletters launch a campaign, and it reaches her in English. She opens "Manage the subscription"
// from that mail, picks Spanish, and the next campaign comes in Spanish with the same link in it.
// Pavlo, who subscribed the same way, presses the button of unsubscribing his mail client shows over
// the first mail, and the next campaign does not reach him. Maria leaves on the page of management,
// and the third campaign reaches neither. The manager reads each person in the list of subscribers
// and the totals of each campaign; the journal of each subscription tells the same story. The
// refusals, the forms of the answers and the details of the sending are the tests of the routes
// (api/newsletters) and of the pass (worker). *.shopwide: a campaign mails every subscription in force
// in the database.

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let desk: ReturnType<typeof newsletterDesk>;
const emails: string[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
  desk = newsletterDesk(app, csrf, sessionCookie(await signIn(app, csrf, staff.manager)));
});

afterEach(async () => {
  // the readers of a flow are not the audience of the next *.shopwide file: the addresses go before
  // the shop lock does, which is before afterAll
  await forget(emails.splice(0));
  // a warning or an error of the pass nobody expected fails the flow
  expect(desk.problems()).toEqual([]);
});

afterAll(async () => {
  try {
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

describe('a guest who subscribes on the page of the shop', () => {
  it('confirms by mail, reads the campaigns in the language of the page of management and leaves', async () => {
    const maria = uniqueEmail('maria');
    const pavlo = uniqueEmail('pavlo');
    emails.push(maria, pavlo);

    // the manager reads the numbers of the subscribers before them
    const before = await desk.summary();

    // Maria fills in the form; the answer is the same for every address
    const api = newsletterApi(app, csrf);
    const mails = watchNewsletterMail();
    const asked = await api.post(SUBSCRIPTIONS, withCaptcha({ email: maria, locale: 'en' }));
    expect(asked.statusCode).toBe(202);
    expect(asked.json()).toEqual(REQUEST_ANSWER);

    // the mail to confirm is in her mailbox; until she confirms, she is a request and no subscriber
    const asking = mails.filter((mail) => mail.to[0] === maria);
    expect(asking).toHaveLength(1);
    expect(await desk.subscribers(maria)).toEqual([
      expect.objectContaining({ source: 'form', status: 'pending', locale: 'en' }),
    ]);

    // the link of the mail opens the page of the shop, and its button confirms
    const confirmed = await api.post(`${SUBSCRIPTIONS}/confirm`, {
      token: mailedToken(asking, CONFIRM_PAGE),
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ status: 'active', locale: 'en' });

    // Pavlo does the same, in English too
    await subscribeOnPage(app, csrf, pavlo, 'en');

    // the manager sees two more subscribers in force, both in English
    const both = await desk.summary();
    expect(both.active).toBe(before.active + 2);
    expect(both.bySource.form).toBe(before.bySource.form + 2);
    expect(countOf(both, 'en')).toBe(countOf(before, 'en') + 2);

    // the first campaign goes out, and both find it in their mailboxes in English
    const first = await desk.launch('A');
    const [firstMail] = first.to(maria);
    expect(first.to(maria)).toHaveLength(1);
    expect(firstMail).toMatchObject({
      stream: 'newsletter',
      accepted: true,
      subject: subjectOf('en', 'A'),
    });
    expect(firstMail!.text).toContain(greetingOf('en', 'A'));
    expect(first.to(pavlo)).toHaveLength(1);

    // Maria follows "Manage the subscription" of the mail: the page shows her subscription, and she
    // picks Spanish
    const token = manageTokenOf(firstMail!);
    const page = await api.post(`${BASE}/manage`, { token });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({
      email: maria,
      source: 'form',
      locale: 'en',
      status: 'active',
      canChangeLocale: true,
    });
    const changed = await api.post(`${BASE}/manage/locale`, { token, locale: 'es' });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ locale: 'es', status: 'active' });

    // Pavlo presses the button of unsubscribing that his mail client shows over the mail
    const clicked = await pressUnsubscribe(app, first.to(pavlo)[0]!);
    expect(clicked.statusCode).toBe(200);
    expect(clicked.json()).toEqual({ unsubscribed: true });

    // the second campaign: Maria gets it in Spanish, with the same link of management as before,
    // and Pavlo gets nothing
    const second = await desk.launch('B');
    const [secondMail] = second.to(maria);
    expect(second.to(maria)).toHaveLength(1);
    expect(secondMail).toMatchObject({ accepted: true, subject: subjectOf('es', 'B') });
    expect(secondMail!.text).toContain(greetingOf('es', 'B'));
    expect(secondMail!.text).toContain(dictionaryText('es', 'campaignMail.manage'));
    expect(manageTokenOf(secondMail!)).toBe(token);
    expect(second.to(pavlo)).toEqual([]);

    // before she leaves, Maria takes the data the shop keeps of her subscription from the page
    const data = await api.post(`${BASE}/manage/export`, { token });
    expect(data.statusCode).toBe(200);
    expect(data.json().subscriptions).toEqual([
      expect.objectContaining({
        email: maria,
        source: 'form',
        locale: 'es',
        status: 'active',
        events: [
          expect.objectContaining({ event: 'requested', place: 'form' }),
          expect.objectContaining({ event: 'confirmed', place: 'form' }),
          expect.objectContaining({ event: 'locale_changed', place: 'manage_page' }),
        ],
      }),
    ]);
    expect(data.body).not.toContain(token);

    // Maria leaves on the page of management; reopening the page finds no subscription
    const left = await api.post(`${BASE}/manage/unsubscribe`, { token });
    expect(left.statusCode).toBe(200);
    expect(left.json()).toEqual({ unsubscribed: true });
    const reopened = await api.post(`${BASE}/manage`, { token });
    expect(reopened.statusCode).toBe(400);
    expect(reopened.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });

    // the third campaign reaches neither of them
    const third = await desk.launch('C');
    expect(third.to(maria)).toEqual([]);
    expect(third.to(pavlo)).toEqual([]);

    // the numbers of the manager are back where they were
    expect((await desk.summary()).active).toBe(before.active);

    // the manager finds both subscriptions over, each in the language it had at the end
    expect(await desk.subscribers(maria)).toEqual([
      expect.objectContaining({
        source: 'form',
        status: 'ended',
        endReason: 'unsubscribed',
        locale: 'es',
      }),
    ]);
    expect(await desk.subscribers(pavlo)).toEqual([
      expect.objectContaining({
        source: 'form',
        status: 'ended',
        endReason: 'unsubscribed',
        locale: 'en',
      }),
    ]);

    // the journal of each subscription is the story told above; Pavlo's last line names the campaign
    // whose mail he pressed the button of
    expect((await journalOf(maria)).map((line) => [line.event, line.place])).toEqual([
      ['requested', 'form'],
      ['confirmed', 'form'],
      ['locale_changed', 'manage_page'],
      ['unsubscribed', 'manage_page'],
    ]);
    const pavloLines = await journalOf(pavlo);
    expect(pavloLines.map((line) => [line.event, line.place])).toEqual([
      ['requested', 'form'],
      ['confirmed', 'form'],
      ['unsubscribed', 'mail_client'],
    ]);
    expect(pavloLines.at(-1)!.campaignId).toBe(first.id);

    // every campaign has gone out to the audience it began with, and only the first one has the
    // unsubscribe of the mail client in its total
    for (const [campaign, unsubscribed] of [
      [first, 1],
      [second, 0],
      [third, 0],
    ] as const) {
      const read = await desk.campaign(campaign.id);
      expect(read.status).toBe('finished');
      expect(read.counters).toEqual({
        planned: campaign.mails.length,
        sent: campaign.mails.length,
        rejected: 0,
        undelivered: 0,
        complaints: 0,
        unsubscribed,
      });
    }
  });
});

describe('a reader who follows the link of unsubscribing of a mail in the browser', () => {
  it('is sent to the page of management, which asks and posts, and the next campaign does not reach her', async () => {
    const olha = uniqueEmail('olha');
    emails.push(olha);
    await subscribeOnPage(app, csrf, olha, 'en');

    const first = await desk.launch('L');
    const [mail] = first.to(olha);
    expect(first.to(olha)).toHaveLength(1);

    // the link of the button of the mail, opened in the browser: the page of management, which
    // changes nothing by itself (a scanner of links may open it too)
    const header = mail!.headers['List-Unsubscribe'] ?? '';
    const link = new URL(/^<(https?:\/\/[^>]+)>$/.exec(header)![1]!);
    const opened = await app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
    expect(opened.statusCode).toBe(303);
    const page = new URL(String(opened.headers.location));
    const unsubscribeToken = new URLSearchParams(page.hash.slice(1)).get('unsubscribe');
    expect(unsubscribeToken).toBe(link.pathname.split('/').at(-1));
    expect(await desk.subscribers(olha)).toEqual([expect.objectContaining({ status: 'active' })]);

    // the page asks her, she says yes: it posts to the same address
    const left = await app.inject({
      method: 'POST',
      url: `${link.pathname}${link.search}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(left.statusCode).toBe(200);
    expect(left.json()).toEqual({ unsubscribed: true });

    const second = await desk.launch('M');
    expect(second.to(olha)).toEqual([]);
    expect(await desk.subscribers(olha)).toEqual([
      expect.objectContaining({ status: 'ended', endReason: 'unsubscribed' }),
    ]);
  });
});

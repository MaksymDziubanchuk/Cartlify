import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { sessionCookie, signIn } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, uniqueEmail } from '../../helpers/factories.js';
import { watchSpamReportClearing } from '../../helpers/mail.js';
import {
  BASE,
  SUBSCRIPTIONS,
  forget,
  journalOf,
  newsletterApi,
} from '../../helpers/newsletterApi.js';
import {
  manageTokenOf,
  newsletterDesk,
  reportOf,
  signInAccepting,
  subjectOf,
  subscribeOnPage,
} from '../../helpers/newsletterFlow.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../helpers/newsletterStaff.js';
import { deliverEvents } from '../../helpers/newsletterWebhook.js';

// What SendGrid tells about the mails that went out, each step with what its actor sees. A buyer
// whose account is subscribed marks the first campaign as spam in her mail client; SendGrid reports it
// and the profile shows the subscription paused (the manager sees the complaint in the totals of the
// campaign), the next campaign does not reach her, and she resumes from the page of management that
// the link of the mail opens: the shop clears her address from the list of spam reports of SendGrid,
// and the campaign after that reaches her again. A guest whose address does not exist gets the first
// campaign bounced: the subscription is stopped, the next campaign does not reach the address, the
// link of the old mail finds nothing, and when the guest asks the form again and confirms, she is
// mailed again. The refusals, the signatures of the webhook and the forms of its answers are the tests
// of the webhook (api/newsletters). *.shopwide: a campaign mails every subscription in force in the
// database.

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let desk: ReturnType<typeof newsletterDesk>;
const emails: string[] = [];
const userIds: number[] = [];

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
    await closeSessions(userIds);
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

describe('a subscriber who marks a campaign as spam', () => {
  it('is paused by the report, misses the next campaign and resumes from the page of management', async () => {
    const buyer = await createUser({ name: 'Complaining Buyer', locale: 'en' });
    userIds.push(buyer.id);
    emails.push(buyer.email);
    const api = newsletterApi(app, csrf);
    const mine = { cookie: sessionCookie(await signInAccepting(app, csrf, buyer)) };
    const cleared = watchSpamReportClearing();

    // the buyer subscribes from the profile
    expect((await api.post(SUBSCRIPTIONS, {}, mine)).statusCode).toBe(201);

    // the first campaign reaches her; she marks it as spam, and SendGrid reports it with the marks of
    // that mail
    const first = await desk.launch('A');
    const [mail] = first.to(buyer.email);
    expect(first.to(buyer.email)).toHaveLength(1);
    const reported = await deliverEvents(app, [reportOf(mail!, 'spamreport')]);
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toEqual({ received: true, applied: 1, skipped: 0 });

    // the profile shows the subscription paused, the manager sees the complaint in the totals and the
    // subscriber paused
    expect((await api.get(`${BASE}/me`, mine)).json()).toMatchObject({
      subscribed: true,
      status: 'paused_complaint',
    });
    expect((await desk.campaign(first.id)).counters).toMatchObject({
      sent: first.mails.length,
      complaints: 1,
    });
    expect(await desk.subscribers(buyer.email)).toEqual([
      expect.objectContaining({ status: 'paused_complaint', endReason: null }),
    ]);

    // the next campaign does not reach her
    const second = await desk.launch('B');
    expect(second.to(buyer.email)).toEqual([]);

    // the link of the first mail still opens the page of management, which shows the pause; she
    // resumes there, and the shop clears her address from the list of spam reports of SendGrid, or the
    // next mail would not be delivered
    const token = manageTokenOf(mail!);
    const page = await api.post(`${BASE}/manage`, { token });
    expect(page.json()).toMatchObject({ email: buyer.email, status: 'paused_complaint' });
    const resumed = await api.post(`${BASE}/manage/resume`, { token });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ status: 'active' });
    expect(cleared).toEqual([{ email: buyer.email, stream: 'newsletter', status: 204 }]);
    expect((await api.get(`${BASE}/me`, mine)).json()).toMatchObject({
      subscribed: true,
      status: 'active',
    });

    // the campaign after that reaches her again, in English
    const third = await desk.launch('C');
    expect(third.to(buyer.email)).toHaveLength(1);
    expect(third.to(buyer.email)[0]).toMatchObject({
      accepted: true,
      subject: subjectOf('en', 'C'),
    });

    // the journal: the complaint names the campaign it came from, and the resume the page it was made on
    const lines = await journalOf(buyer.email);
    expect(lines.map((line) => [line.event, line.place])).toEqual([
      ['subscribed', 'profile'],
      ['complaint', 'webhook'],
      ['restored', 'manage_page'],
    ]);
    expect(lines[1]!.campaignId).toBe(first.id);
  });
});

describe('a subscriber whose address does not exist', () => {
  it('is stopped by the bounce, is not mailed again and subscribes anew when the address works', async () => {
    const guest = uniqueEmail('bounced');
    emails.push(guest);
    const api = newsletterApi(app, csrf);

    // the guest subscribed on the page of the shop, and the first campaign went to her address
    await subscribeOnPage(app, csrf, guest, 'en');
    const first = await desk.launch('A');
    const [mail] = first.to(guest);
    expect(first.to(guest)).toHaveLength(1);

    // SendGrid reports that the address does not exist
    const reported = await deliverEvents(app, [reportOf(mail!, 'bounce')]);
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toEqual({ received: true, applied: 1, skipped: 0 });

    // the manager sees the subscription stopped, with the reason, and the mail among the ones that
    // did not arrive
    expect(await desk.subscribers(guest)).toEqual([
      expect.objectContaining({ source: 'form', status: 'stopped_bounce', endReason: 'bounced' }),
    ]);
    expect((await desk.campaign(first.id)).counters).toMatchObject({
      sent: first.mails.length,
      undelivered: 1,
    });

    // the next campaign does not go to the address, and the link of the old mail finds no subscription
    const second = await desk.launch('B');
    expect(second.to(guest)).toEqual([]);
    const page = await api.post(`${BASE}/manage`, { token: manageTokenOf(mail!) });
    expect(page.statusCode).toBe(400);
    expect(page.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });

    // the mailbox works again: the guest asks the form and confirms, and the campaign after that
    // reaches her
    await subscribeOnPage(app, csrf, guest, 'es');
    const third = await desk.launch('C');
    expect(third.to(guest)).toHaveLength(1);
    expect(third.to(guest)[0]).toMatchObject({ accepted: true, subject: subjectOf('es', 'C') });

    // the stopped subscription stays beside the new one as it was
    expect(await desk.subscribers(guest)).toEqual([
      expect.objectContaining({ status: 'stopped_bounce', endReason: 'bounced', locale: 'en' }),
      expect.objectContaining({ status: 'active', endReason: null, locale: 'es' }),
    ]);
    expect((await journalOf(guest)).map((line) => [line.event, line.place])).toEqual([
      ['requested', 'form'],
      ['confirmed', 'form'],
      ['bounced', 'webhook'],
      ['requested', 'form'],
      ['confirmed', 'form'],
    ]);
  });
});

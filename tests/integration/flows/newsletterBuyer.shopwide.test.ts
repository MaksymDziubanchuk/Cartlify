import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { sessionCookie, signIn } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { cookieHeader, cookieJar } from '../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { dictionaryText } from '../../helpers/dictionary.js';
import { closeSessions, uniqueEmail, uniqueTag } from '../../helpers/factories.js';
import { linkParams, watchMail } from '../../helpers/mail.js';
import {
  BASE,
  SUBSCRIPTIONS,
  forget,
  journalOf,
  newsletterApi,
} from '../../helpers/newsletterApi.js';
import {
  accepting,
  documentsToAccept,
  greetingOf,
  manageTokenOf,
  newsletterDesk,
  pressUnsubscribe,
  signInAccepting,
  subjectOf,
} from '../../helpers/newsletterFlow.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../helpers/newsletterStaff.js';
import {
  callback,
  FRONTEND_CALLBACK,
  landing,
  oidcProvider,
  startLogin,
} from '../../helpers/oauth.js';
import { withCaptcha } from '../../helpers/turnstile.js';

// A buyer and the newsletter, each step with what the buyer sees. The first buyer ticks the box of
// the newsletter on the form of the registration (in Spanish), opens the link of the mail that
// confirms the address, where the box is ticked already, and presses the button: the profile shows
// the subscription. The first campaign reaches her in Spanish; the button of unsubscribing in her
// mail client ends the subscription, the profile says so, and the next campaign does not reach her.
// She ticks the box in the profile again, switches the language of the newsletter to English
// (the language of the account stays), and the next campaign comes in English. The second buyer signs
// in with Google, whose page asked for the newsletter: the subscription is in the language Google
// told, the campaign comes in it, and the buyer leaves on the page of management, which for an account
// leaves the language to the profile. The refusals of each step are the tests of the routes
// (api/auth, api/newsletters). *.shopwide: a campaign mails every subscription in force in the database.

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let desk: ReturnType<typeof newsletterDesk>;
const emails: string[] = [];
const userIds: number[] = [];
const google = oidcProvider('google');

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
  desk = newsletterDesk(app, csrf, sessionCookie(await signIn(app, csrf, staff.manager)));
});

afterEach(async () => {
  jest.restoreAllMocks();
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

describe('a buyer who registers with the box of the newsletter ticked', () => {
  it('confirms the address, reads the campaigns in the language chosen, leaves with the button of the mail client and subscribes again', async () => {
    const email = uniqueEmail('buyer');
    const password = 'flow-buyer-password-1';
    emails.push(email);
    const orderMails = watchMail();

    // the registration form, with the box ticked, Spanish chosen and the terms of the shop accepted
    // if it has any
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: withCsrf(csrf),
      payload: withCaptcha({
        email,
        password,
        name: 'Buyer Flow',
        locale: 'es',
        newsletter: true,
        ...accepting(await documentsToAccept(app)),
      }),
    });
    expect(registered.statusCode).toBe(201);
    const userId = registered.json().id as number;
    userIds.push(userId);

    // the link of the mail to confirm the address carries the box as ticked; the page of the shop
    // shows it so, and the button sends the token with that choice
    const link = linkParams(orderMails.at(-1)!, '/web/login')!;
    expect(link.get('newsletter')).toBe('1');
    const verified = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: withCsrf(csrf),
      payload: { token: link.get('token')!, newsletter: true },
    });
    expect(verified.statusCode).toBe(200);

    // she logs in and the profile shows the subscription of her account, in the language she chose
    const session = await signInAccepting(app, csrf, { email, password });
    const mine = { cookie: sessionCookie(session) };
    const api = newsletterApi(app, csrf);
    const subscription = await api.get(`${BASE}/me`, mine);
    expect(subscription.json()).toMatchObject({
      subscribed: true,
      source: 'account',
      status: 'active',
      locale: 'es',
      canChangeLocale: true,
    });

    // the first campaign reaches her in Spanish
    const first = await desk.launch('A');
    expect(first.to(email)).toHaveLength(1);
    const [firstMail] = first.to(email);
    expect(firstMail).toMatchObject({ accepted: true, subject: subjectOf('es', 'A') });
    expect(firstMail!.text).toContain(greetingOf('es', 'A'));
    expect(firstMail!.text).toContain(dictionaryText('es', 'campaignMail.manage'));

    // the button of her mail client unsubscribes her; the profile says so
    const clicked = await pressUnsubscribe(app, firstMail!);
    expect(clicked.statusCode).toBe(200);
    expect(clicked.json()).toEqual({ unsubscribed: true });
    expect((await api.get(`${BASE}/me`, mine)).json()).toEqual({ subscribed: false });

    // the next campaign does not reach her
    const second = await desk.launch('B');
    expect(second.to(email)).toEqual([]);

    // she ticks the box in the profile again; no mail is asked of her, the subscription is in force
    // at once, in the language of her account, and she switches it to English
    const resubscribed = await api.post(SUBSCRIPTIONS, {}, mine);
    expect(resubscribed.statusCode).toBe(201);
    expect(resubscribed.json()).toMatchObject({
      subscribed: true,
      source: 'account',
      status: 'active',
      locale: 'es',
    });
    const switched = await api.patch(`${BASE}/me`, { locale: 'en' }, mine);
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ status: 'active', locale: 'en' });
    const account = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: mine,
    });
    expect(account.json().locale).toBe('es');

    // the third campaign comes in English
    const third = await desk.launch('C');
    const [thirdMail] = third.to(email);
    expect(third.to(email)).toHaveLength(1);
    expect(thirdMail).toMatchObject({ subject: subjectOf('en', 'C') });
    expect(thirdMail!.text).toContain(dictionaryText('en', 'campaignMail.manage'));

    // the manager finds her two subscriptions: the one that ended and the one in force
    expect(await desk.subscribers(email)).toEqual([
      expect.objectContaining({
        source: 'account',
        status: 'ended',
        endReason: 'unsubscribed',
        locale: 'es',
        userId,
      }),
      expect.objectContaining({ source: 'account', status: 'active', locale: 'en', userId }),
    ]);

    // the journal tells the same story; the button of the mail client names the campaign it was in
    const lines = await journalOf(email);
    expect(lines.map((line) => [line.event, line.place])).toEqual([
      ['subscribed', 'registration'],
      ['unsubscribed', 'mail_client'],
      ['subscribed', 'profile'],
      ['locale_changed', 'profile'],
    ]);
    expect(lines[1]!.campaignId).toBe(first.id);
    expect((await desk.campaign(first.id)).counters.unsubscribed).toBe(1);
  });
});

describe('a buyer who signs in with Google asking for the newsletter', () => {
  it('is subscribed in the language Google tells, reads the campaign in it and leaves on the page of management', async () => {
    const email = uniqueEmail('buyer-google');
    emails.push(email);
    google.answer(
      google.idToken({
        sub: `google-${uniqueTag()}`,
        email,
        email_verified: true,
        name: 'Google Buyer',
        locale: 'uk',
      }),
    );

    // the page of the shop starts the login with the newsletter asked for (and the terms of the shop
    // accepted, if it has any); the first login makes the account
    const documents = await documentsToAccept(app);
    const started = await startLogin(app, 'google', '', {
      newsletter: 'true',
      ...(documents.length ? { acceptedDocumentIds: documents.join(',') } : {}),
    });
    const signedIn = await callback(
      app,
      'google',
      { code: 'flow-code', state: started.state },
      cookieHeader({ guestId: started.guestId }),
    );
    expect(landing(signedIn)).toEqual({ status: 302, page: FRONTEND_CALLBACK, error: null });
    jest.restoreAllMocks();
    const mine = { cookie: sessionCookie(cookieJar(signedIn)) };
    const me = await app.inject({ method: 'GET', url: '/api/users/me', headers: mine });
    expect(me.statusCode).toBe(200);
    userIds.push(me.json().id as number);

    // the profile shows the subscription, in the language Google told
    const api = newsletterApi(app, csrf);
    expect((await api.get(`${BASE}/me`, mine)).json()).toMatchObject({
      subscribed: true,
      source: 'account',
      status: 'active',
      locale: 'uk',
    });

    // the campaign comes in that language
    const launched = await desk.launch('D');
    const [mail] = launched.to(email);
    expect(launched.to(email)).toHaveLength(1);
    expect(mail).toMatchObject({ accepted: true, subject: subjectOf('uk', 'D') });
    expect(mail!.text).toContain(greetingOf('uk', 'D'));
    expect(mail!.text).toContain(dictionaryText('uk', 'campaignMail.manage'));

    // "Manage the subscription" shows an account's subscription, whose language is changed in the
    // profile and not here; the buyer leaves from this page, and the profile follows
    const token = manageTokenOf(mail!);
    const page = await api.post(`${BASE}/manage`, { token });
    expect(page.json()).toEqual({
      email,
      source: 'account',
      locale: 'uk',
      status: 'active',
      canChangeLocale: false,
    });
    const left = await api.post(`${BASE}/manage/unsubscribe`, { token });
    expect(left.json()).toEqual({ unsubscribed: true });
    expect((await api.get(`${BASE}/me`, mine)).json()).toEqual({ subscribed: false });

    // the next campaign does not reach the buyer
    const next = await desk.launch('E');
    expect(next.to(email)).toEqual([]);
    expect(await desk.subscribers(email)).toEqual([
      expect.objectContaining({ source: 'account', status: 'ended', endReason: 'unsubscribed' }),
    ]);
    expect((await journalOf(email)).map((line) => [line.event, line.place])).toEqual([
      ['subscribed', 'registration'],
      ['unsubscribed', 'manage_page'],
    ]);
  });
});

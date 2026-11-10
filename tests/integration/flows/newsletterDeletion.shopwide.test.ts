import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { sessionCookie, signIn } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import { closeSessions, createUser, uniqueEmail } from '../../helpers/factories.js';
import { linkParams, watchMail } from '../../helpers/mail.js';
import {
  BASE,
  SUBSCRIPTIONS,
  forget,
  journalOf,
  newsletterApi,
  rowsOf,
} from '../../helpers/newsletterApi.js';
import {
  accepting,
  documentsToAccept,
  newsletterDesk,
  signInAccepting,
  subscribeOnPage,
} from '../../helpers/newsletterFlow.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../helpers/newsletterStaff.js';
import { withCaptcha } from '../../helpers/turnstile.js';

// What happens to the newsletter when buyers delete their accounts, each step with what they see.
// Olena subscribed on the page of the shop as a guest, then registered with the same address and ticked
// the box: she has one subscription, the one of the form, and the profile shows it. Taras subscribed in
// his profile. The first campaign reaches each of them once. Olena takes her data, the subscription is
// in it, and both delete their accounts; the mail of each deletion says the subscription ended too. The
// next campaign reaches neither, the manager sees both subscriptions over because the accounts were
// deleted, and nothing of the accounts is left but that. The refusals and every state of a
// subscription are the tests of the routes (api/users, api/newsletters). *.shopwide: a campaign mails
// every subscription in force in the database.

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

describe('buyers who delete their accounts', () => {
  it('end their subscriptions, the one of the form and the one of the account, and no campaign reaches them after', async () => {
    const olena = uniqueEmail('olena');
    const olenaPassword = 'flow-olena-password-1';
    emails.push(olena);
    const api = newsletterApi(app, csrf);
    const orderMails = watchMail();

    // Olena subscribes on the page of the shop as a guest
    await subscribeOnPage(app, csrf, olena, 'en');

    // then she registers with the same address, accepting the terms of the shop if it has any, and
    // ticks the box; the link of the mail confirms the address with the box as she left it
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: withCsrf(csrf),
      payload: withCaptcha({
        email: olena,
        password: olenaPassword,
        name: 'Olena Flow',
        newsletter: true,
        ...accepting(await documentsToAccept(app)),
      }),
    });
    expect(registered.statusCode).toBe(201);
    const olenaId = registered.json().id as number;
    userIds.push(olenaId);
    const link = linkParams(orderMails.at(-1)!, '/web/login')!;
    const verified = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: withCsrf(csrf),
      payload: { token: link.get('token')!, newsletter: link.get('newsletter') === '1' },
    });
    expect(verified.statusCode).toBe(200);

    // her profile shows the subscription of the form, the only one the address has
    const olenaSession = await signInAccepting(app, csrf, {
      email: olena,
      password: olenaPassword,
    });
    const olenaCookie = { cookie: sessionCookie(olenaSession) };
    expect((await api.get(`${BASE}/me`, olenaCookie)).json()).toMatchObject({
      subscribed: true,
      source: 'form',
      status: 'active',
    });
    expect(await desk.subscribers(olena)).toEqual([
      expect.objectContaining({ source: 'form', status: 'active' }),
    ]);

    // Taras subscribes in his profile
    const taras = await createUser({ name: 'Taras Flow' });
    userIds.push(taras.id);
    emails.push(taras.email);
    const tarasSession = await signInAccepting(app, csrf, taras);
    const tarasCookie = { cookie: sessionCookie(tarasSession) };
    expect((await api.post(SUBSCRIPTIONS, {}, tarasCookie)).statusCode).toBe(201);

    // the first campaign reaches each of them once
    const first = await desk.launch('A');
    expect(first.to(olena)).toHaveLength(1);
    expect(first.to(taras.email)).toHaveLength(1);

    // Olena takes her data, and the subscription is in it with what led to it
    const data = await app.inject({
      method: 'GET',
      url: '/api/users/me/export',
      headers: olenaCookie,
    });
    expect(data.statusCode).toBe(200);
    expect(data.json().newsletterSubscriptions).toEqual([
      expect.objectContaining({
        source: 'form',
        status: 'active',
        events: [
          expect.objectContaining({ event: 'requested', place: 'form' }),
          expect.objectContaining({ event: 'confirmed', place: 'form' }),
        ],
      }),
    ]);

    // both delete their accounts; each mail of the deletion says the subscription ended too
    orderMails.length = 0;
    for (const [who, cookie, password] of [
      [olena, olenaCookie, olenaPassword],
      [taras.email, tarasCookie, taras.password],
    ] as const) {
      const left = await app.inject({
        method: 'DELETE',
        url: '/api/users/me',
        headers: withCsrf(csrf, cookie.cookie),
        payload: { password },
      });
      expect(left.statusCode).toBe(204);

      const farewell = orderMails.filter((mail) => mail.to[0] === who);
      expect(farewell).toHaveLength(1);
      expect(farewell[0]!.text).toContain(
        'Your newsletter subscription has been cancelled as well.',
      );
    }

    // the next campaign reaches neither of them
    const second = await desk.launch('B');
    expect(second.to(olena)).toEqual([]);
    expect(second.to(taras.email)).toEqual([]);

    // the manager finds both subscriptions over, for the reason that the accounts were deleted
    expect(await desk.subscribers(olena)).toEqual([
      expect.objectContaining({ source: 'form', status: 'ended', endReason: 'account_deleted' }),
    ]);
    expect(await desk.subscribers(taras.email)).toEqual([
      expect.objectContaining({ source: 'account', status: 'ended', endReason: 'account_deleted' }),
    ]);

    // the journals end with the deletion
    expect((await journalOf(olena)).map((line) => [line.event, line.place])).toEqual([
      ['requested', 'form'],
      ['confirmed', 'form'],
      ['account_deleted', 'profile'],
    ]);
    expect((await journalOf(taras.email)).map((line) => [line.event, line.place])).toEqual([
      ['subscribed', 'profile'],
      ['account_deleted', 'profile'],
    ]);

    // of the accounts nothing is left but the deletion: no address, no way to log in again; the only
    // trace of each address is the ended subscription, the proof of the consent
    for (const id of [olenaId, taras.id]) {
      const row = await asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { id } }));
      expect(row.deletedAt).not.toBeNull();
      expect(row.email).toMatch(/^deleted\+/);
      expect(row.passwordHash).toBeNull();
    }
    expect(await rowsOf(olena)).toHaveLength(1);
    expect(await rowsOf(taras.email)).toHaveLength(1);
  });
});

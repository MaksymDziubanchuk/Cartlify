import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { sessionCookie, signIn } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, uniqueEmail } from '../../helpers/factories.js';
import { mailedToken, watchNewsletterMail } from '../../helpers/mail.js';
import {
  BASE,
  CONFIRM_PAGE,
  REQUEST_ANSWER,
  SUBSCRIPTIONS,
  forget,
  newsletterApi,
  publicAnswer,
  rowsOf,
} from '../../helpers/newsletterApi.js';
import { withCaptcha } from '../../helpers/turnstile.js';

// An address that is spammed with requests of the public form, and the people who deal with it. A
// person writes to support@ that strangers keep subscribing her address (she gets a mail to confirm
// every time); an admin whom root allowed blocks the address; the strangers' requests are answered as
// ever and no mail goes out; she subscribes from her account, which the block does not touch, and
// later leaves; she asks support to take the block off and a request of the form is mailed again. Each
// step shows what its actor sees. The refusals, the forms of the answers and every state of an address
// are the tests of the routes (api/newsletters)

let app: FastifyInstance;
let csrf: Csrf;
const emails: string[] = [];
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await forget(emails);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('an address that is spammed with requests', () => {
  it('is blocked on the word of the person, its owner still subscribes, and the block is taken off', async () => {
    const root = await createUser({ role: 'ROOT' });
    const admin = await createUser({ role: 'ADMIN', name: 'Support Admin' });
    const olena = await createUser({ name: 'Olena Spammed', locale: 'uk' });
    userIds.push(root.id, admin.id, olena.id);
    emails.push(olena.email);
    const bystander = uniqueEmail('bystander');
    emails.push(bystander);

    const rootSession = await signIn(app, csrf, root);
    const adminSession = await signIn(app, csrf, admin);
    const olenaSession = await signIn(app, csrf, olena);
    const api = newsletterApi(app, csrf);
    const rootCookie = { cookie: sessionCookie(rootSession) };
    const adminCookie = { cookie: sessionCookie(adminSession) };
    const olenaCookie = { cookie: sessionCookie(olenaSession) };

    // root allows the admin to run the newsletters
    const allowed = await api.patch(
      `/api/root/admins/${admin.id}`,
      { canManageNewsletters: true },
      rootCookie,
    );
    expect(allowed.statusCode).toBe(200);

    // a stranger asks the form to subscribe the address of Olena; the mailbox of Olena gets a mail to
    // confirm, which she did not ask for. A request about another address is answered the same way:
    // that is the answer every visitor gets
    const mails = watchNewsletterMail();
    const first = await api.post(SUBSCRIPTIONS, withCaptcha({ email: olena.email, locale: 'en' }));
    const otherAnswer = await api.post(
      SUBSCRIPTIONS,
      withCaptcha({ email: bystander, locale: 'en' }),
    );
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual(REQUEST_ANSWER);
    const spamToken = mailedToken(
      mails.filter((mail) => mail.to.includes(olena.email)),
      CONFIRM_PAGE,
    );

    // she writes to support@ (outside the app); the admin looks the address up and finds nothing
    const searched = await api.get(
      `${BASE}/blocklist?email=${encodeURIComponent(olena.email)}`,
      adminCookie,
    );
    expect(searched.statusCode).toBe(200);
    expect(searched.json()).toEqual({ blocked: false, entry: null });

    // the admin blocks the address, the reason is the word of the person
    const blocked = await api.post(
      `${BASE}/blocklist`,
      { email: olena.email, reason: 'asked through support: spammed with requests' },
      adminCookie,
    );
    expect(blocked.statusCode).toBe(201);
    const entry = blocked.json().entry as { id: number; blockedById: number; reason: string };
    expect(entry).toMatchObject({
      blockedById: admin.id,
      byPerson: false,
      reason: 'asked through support: spammed with requests',
    });

    // the admin finds the entry by the address, written any way
    const found = await api.get(
      `${BASE}/blocklist?email=${encodeURIComponent(` ${olena.email.toUpperCase()} `)}`,
      adminCookie,
    );
    expect(found.json()).toMatchObject({ blocked: true, entry: { id: entry.id } });

    // the mail the stranger caused is a dead link now: the request it confirmed is gone
    const confirmed = await api.post(`${SUBSCRIPTIONS}/confirm`, { token: spamToken });
    expect(confirmed.statusCode).toBe(400);
    expect(confirmed.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });

    // the stranger asks again, with the address written another way: the answer is what any request
    // gets, and no mail goes to Olena
    mails.length = 0;
    const again = await api.post(
      SUBSCRIPTIONS,
      withCaptcha({ email: olena.email.toUpperCase(), locale: 'en' }),
    );
    expect(again.statusCode).toBe(202);
    expect(publicAnswer(again).body).toBe(publicAnswer(otherAnswer).body);
    expect(mails.filter((mail) => mail.to.includes(olena.email))).toEqual([]);

    // Olena subscribes from her account: the block is for the form and does not touch her
    const subscribed = await api.post(SUBSCRIPTIONS, {}, olenaCookie);
    expect(subscribed.statusCode).toBe(201);
    expect(subscribed.json()).toMatchObject({
      subscribed: true,
      source: 'account',
      status: 'active',
    });
    const mine = await api.get(`${BASE}/me`, olenaCookie);
    expect(mine.json()).toMatchObject({ subscribed: true, status: 'active' });

    // she changes her mind and leaves; the address is blocked still
    const left = await api.delete(`${BASE}/me`, olenaCookie);
    expect(left.json()).toEqual({ unsubscribed: true });
    const still = await api.get(
      `${BASE}/blocklist?email=${encodeURIComponent(olena.email)}`,
      adminCookie,
    );
    expect(still.json()).toMatchObject({ blocked: true, entry: { id: entry.id } });

    // she asks support to take the block off; the admin does, and the address is free
    const removed = await api.delete(`${BASE}/blocklist/${entry.id}`, adminCookie);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: true });
    const free = await api.get(
      `${BASE}/blocklist?email=${encodeURIComponent(olena.email)}`,
      adminCookie,
    );
    expect(free.json()).toEqual({ blocked: false, entry: null });

    // a request of the form for the address is mailed again, in the language it asked for, and the
    // link of that mail subscribes the address
    mails.length = 0;
    const mailedAgain = await api.post(
      SUBSCRIPTIONS,
      withCaptcha({ email: olena.email, locale: 'uk' }),
    );
    expect(mailedAgain.statusCode).toBe(202);
    expect(publicAnswer(mailedAgain).body).toBe(publicAnswer(first).body);
    const token = mailedToken(
      mails.filter((mail) => mail.to.includes(olena.email)),
      CONFIRM_PAGE,
    );
    const confirmedNow = await api.post(`${SUBSCRIPTIONS}/confirm`, { token });
    expect(confirmedNow.statusCode).toBe(200);
    expect(confirmedNow.json()).toEqual({ status: 'active', locale: 'uk' });

    // root reads what the admin did in the log: the block and its removal, by the id of the entry
    // and never by the address
    const log = await api.get(
      `/api/admin/audit-log?entityType=newsletter_block&entityId=${entry.id}&sortBy=id&sortOrder=asc`,
      rootCookie,
    );
    expect(log.statusCode).toBe(200);
    const lines = log.json().items as { event: string; actorId: number }[];
    expect(lines.map((line) => line.event)).toEqual([
      'newsletter.block_added',
      'newsletter.block_removed',
    ]);
    expect(lines.every((line) => line.actorId === admin.id)).toBe(true);
    expect(log.body).not.toContain(olena.email);

    // what is left in the database: the subscription she made by the form, the one of her account
    // ended
    const rows = await rowsOf(olena.email);
    expect(rows.map((row) => [row.source, row.status])).toEqual([
      ['account', 'ended'],
      ['form', 'active'],
    ]);
  });
});

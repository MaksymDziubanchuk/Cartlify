import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { sessionCookie, signIn } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { uniqueEmail } from '../../helpers/factories.js';
import { mailedToken, watchNewsletterMail } from '../../helpers/mail.js';
import {
  BASE,
  CONFIRM_PAGE,
  DECLINE_PAGE,
  REQUEST_ANSWER,
  SUBSCRIPTIONS,
  forget,
  newsletterApi,
  publicAnswer,
  rowsOf,
} from '../../helpers/newsletterApi.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../helpers/newsletterStaff.js';
import { withCaptcha } from '../../helpers/turnstile.js';

// A person whose address a stranger keeps entering in the form of the newsletter, each step with
// what its actor sees. The stranger enters the address of Irina; her mailbox gets a mail to confirm
// a subscription she never asked for, and its second button, "This is not me", blocks the address
// for the form. The stranger tries again and gets the answer every visitor gets, and Irina's mailbox
// stays empty, while an address nobody blocked is still mailed. Support finds the address in the
// blocklist as blocked by the person, and when she asks, takes the block off: the form mails her again
// and the link of that mail subscribes her. How an admin blocks an address on the word of the person
// is the flow newsletterBlocklist; the refusals and the forms of the answers are the tests of the
// routes (api/newsletters).

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
const emails: string[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
});

afterAll(async () => {
  try {
    await forget(emails);
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

describe('an address that a stranger keeps entering in the form', () => {
  it('is blocked by its owner with the button of the mail, and the block is taken off at her request', async () => {
    const irina = uniqueEmail('irina');
    const bystander = uniqueEmail('bystander');
    emails.push(irina, bystander);
    const stranger = newsletterApi(app, csrf);
    const support = newsletterApi(app, csrf);
    const supportSession = { cookie: sessionCookie(await signIn(app, csrf, staff.manager)) };
    const mails = watchNewsletterMail();

    // the stranger enters the address of Irina; the answer is the one every visitor gets
    const first = await stranger.post(SUBSCRIPTIONS, withCaptcha({ email: irina, locale: 'en' }));
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual(REQUEST_ANSWER);

    // Irina finds a mail in her mailbox she did not ask for; its two buttons carry one token, and she
    // presses the second one, "This is not me"
    const unwanted = mails.filter((mail) => mail.to[0] === irina);
    expect(unwanted).toHaveLength(1);
    const token = mailedToken(unwanted, DECLINE_PAGE);
    expect(mailedToken(unwanted, CONFIRM_PAGE)).toBe(token);
    const declined = await stranger.post(`${SUBSCRIPTIONS}/decline`, { token });
    expect(declined.statusCode).toBe(200);
    expect(declined.json()).toEqual({ blocked: true });

    // the other button of that mail does nothing now: the request is gone
    const dead = await stranger.post(`${SUBSCRIPTIONS}/confirm`, { token });
    expect(dead.statusCode).toBe(400);
    expect(dead.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
    expect(await rowsOf(irina)).toEqual([]);

    // the stranger tries again, the address written another way: the answer is the same as for an
    // address nobody blocked, Irina's mailbox stays empty and the other address is mailed
    mails.length = 0;
    const again = await stranger.post(
      SUBSCRIPTIONS,
      withCaptcha({ email: irina.toUpperCase(), locale: 'en' }),
    );
    const other = await stranger.post(
      SUBSCRIPTIONS,
      withCaptcha({ email: bystander, locale: 'en' }),
    );
    expect(publicAnswer(again)).toEqual(publicAnswer(other));
    expect(mails.filter((mail) => mail.to[0] === irina)).toEqual([]);
    expect(mails.filter((mail) => mail.to[0] === bystander)).toHaveLength(1);

    // support finds the address in the blocklist, blocked by the person and not by an admin
    const found = await support.get(
      `${BASE}/blocklist?email=${encodeURIComponent(irina)}`,
      supportSession,
    );
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({
      blocked: true,
      entry: { byPerson: true, blockedById: null },
    });
    const entryId = (found.json().entry as { id: number }).id;
    const bystanderEntry = await support.get(
      `${BASE}/blocklist?email=${encodeURIComponent(bystander)}`,
      supportSession,
    );
    expect(bystanderEntry.json()).toEqual({ blocked: false, entry: null });

    // Irina writes to support@ that she wants the newsletter after all; support takes the block off
    const lifted = await support.delete(`${BASE}/blocklist/${entryId}`, supportSession);
    expect(lifted.statusCode).toBe(200);
    expect(lifted.json()).toEqual({ removed: true });
    const free = await support.get(
      `${BASE}/blocklist?email=${encodeURIComponent(irina)}`,
      supportSession,
    );
    expect(free.json()).toEqual({ blocked: false, entry: null });

    // she asks the form herself, in Spanish; the mail comes and its link subscribes her
    mails.length = 0;
    const retry = await stranger.post(SUBSCRIPTIONS, withCaptcha({ email: irina, locale: 'es' }));
    expect(retry.statusCode).toBe(202);
    const wanted = mails.filter((mail) => mail.to[0] === irina);
    expect(wanted).toHaveLength(1);
    const confirmed = await stranger.post(`${SUBSCRIPTIONS}/confirm`, {
      token: mailedToken(wanted, CONFIRM_PAGE),
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ status: 'active', locale: 'es' });

    // what is left: the request the block took away is gone and one subscription is in force
    expect(await rowsOf(irina)).toEqual([
      expect.objectContaining({ source: 'form', status: 'active', locale: 'es' }),
    ]);
  });
});

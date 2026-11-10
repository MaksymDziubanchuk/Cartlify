import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { uniqueEmail } from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { mailedToken, refuseMail, watchNewsletterMail } from '../../../helpers/mail.js';
import {
  BASE,
  CONFIRM_PAGE,
  MANAGE_PAGE,
  SUBSCRIPTIONS,
  arrange,
  forget,
  newsletterApi,
  passTheDay,
} from '../../../helpers/newsletterApi.js';
import { withCaptcha } from '../../../helpers/turnstile.js';

// What the logs of the server hold about the newsletters. The tokens of the links ride in the body of
// a request (never in an address), so the line of a request has none; the address of a subscriber
// is personal data, and no line of the log of any request names it, whatever the request came to

let app: FastifyInstance;
let csrf: Csrf;
let api: ReturnType<typeof newsletterApi>;
const emails: string[] = [];

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

describe('the logs of the routes of the newsletters', () => {
  it('hold no token and no address, whatever the requests came to', async () => {
    const email = uniqueEmail('logged');
    const other = uniqueEmail('logged-other');
    emails.push(email, other);
    const mails = watchNewsletterMail();
    const secrets = new Set<string>([email, other]);
    app.log.level = 'info';

    try {
      // the whole way of a subscriber, then the requests that fail
      await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }));
      const confirm = mailedToken(mails, CONFIRM_PAGE);
      secrets.add(confirm);
      await api.post(`${SUBSCRIPTIONS}/confirm`, { token: confirm });
      await api.post(`${SUBSCRIPTIONS}/confirm`, { token: confirm });
      await passTheDay(email);
      await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }));
      const manage = mailedToken(mails, MANAGE_PAGE);
      secrets.add(manage);

      await api.post(`${BASE}/manage`, { token: manage });
      await api.post(`${BASE}/manage/locale`, { token: manage, locale: 'fr' });
      await api.post(`${BASE}/manage/locale`, { token: manage, locale: 'es' });
      await api.post(`${BASE}/manage/export`, { token: manage });
      await api.post(`${BASE}/manage`, { token: 'a-wrong-token-of-a-reader' });
      secrets.add('a-wrong-token-of-a-reader');
      await api.post(`${SUBSCRIPTIONS}/decline`, { token: confirm });
      await api.post(`${SUBSCRIPTIONS}/confirm`, { token: 12 as unknown as string });
      await api.post(SUBSCRIPTIONS, { email: other, locale: 'fr', captchaToken: 'x' });
      await api.post(SUBSCRIPTIONS, withCaptcha({ email: 'broken', locale: 'uk' }));
      await api.post(`${BASE}/manage/unsubscribe`, { token: manage });

      // a request whose body is no json, and one that quotes a token in the query
      await app.inject({
        method: 'POST',
        url: `${BASE}/manage?token=${manage}`,
        headers: { ...withCsrf(csrf), 'content-type': 'application/json' },
        payload: `{"token": "${manage}"`,
      });
    } finally {
      app.log.level = 'warn';
    }

    const lines = takeLogs({});
    const text = JSON.stringify(lines);

    expect(lines.length).toBeGreaterThan(10);
    for (const secret of secrets) expect(text).not.toContain(secret);
    // the query that quoted a token has its value hidden
    expect(text).toContain('/api/newsletters/manage?token=[hidden]');
  });

  it('hold no address in the warning of a mail the provider did not take', async () => {
    const email = uniqueEmail('logged-refused');
    emails.push(email);
    refuseMail('newsletter');

    await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }));
    await arrange({ email: uniqueEmail('logged-refused-known') }).then(async (row) => {
      emails.push(row.email);
      await passTheDay(row.email);
      await api.post(SUBSCRIPTIONS, withCaptcha({ email: row.email, locale: 'uk' }));
    });

    const lines = takeLogs({ msg: 'newsletter subscription mail was not sent' });

    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain('@');
  });
});

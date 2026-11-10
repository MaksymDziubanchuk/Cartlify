import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createUser, uniqueEmail, type TestUser } from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { withCaptcha } from '../../helpers/turnstile.js';

// a person with no language of their own (a guest, or an account that never set one) is mailed
// in the shop's own language (shopSettings().shopLocale), and a different one once root changes
// it. tests/unit/helpers/locale.test.ts proves the rule itself (mailLocaleOf); this file proves a
// real send-helper actually asks it, through the password-forgot mail of an account with no
// locale of its own (the same path a guest's mail takes: mailLocaleOf(null))
// *.shopwide.test.ts: the table is one for every test file running next to it, this file runs
// alone while it runs (tests/setup/integration.shopState.ts)

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
const userIds: number[] = [];
// the languages of the shop as this file found them: it leaves them so, the files after it mail
// in the language they expect
let found: { shopLocale: string; enabledLocales: string[] };

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT' });
  userIds.push(root.id);
  const { shopLocale, enabledLocales } = await currentValues();
  found = { shopLocale, enabledLocales };
});

afterAll(async () => {
  try {
    await setShopLocale(found.shopLocale, found.enabledLocales);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const currentValues = async () =>
  (
    await app.inject({
      method: 'GET',
      url: '/api/admin/shop-settings',
      headers: { cookie: accessCookie(root) },
    })
  ).json();

const setShopLocale = async (shopLocale: string, enabledLocales = ['en', 'uk', 'es']) => {
  const values = await currentValues();
  const { logoUrl: _logoUrl, ...rest } = values;

  const res = await app.inject({
    method: 'PUT',
    url: '/api/root/shop-settings',
    headers: withCsrf(csrf, accessCookie(root)),
    payload: { ...rest, shopLocale, enabledLocales },
  });
  expect(res.statusCode).toBe(200);
};

const forgot = (email: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/password/forgot',
    headers: withCsrf(csrf),
    payload: withCaptcha({ email }),
  });

describe('a mail to a person with no language of their own', () => {
  it.each([
    ['uk', 'Відновлення пароля'],
    ['es', 'Restablece tu contraseña'],
  ])("goes in the shop's own language, %s, once root sets it", async (shopLocale, subjectPart) => {
    await setShopLocale(shopLocale);

    const user = await createUser({ email: uniqueEmail('mail-locale') });
    userIds.push(user.id);
    const mails = watchMail();

    const res = await forgot(user.email);

    expect(res.statusCode).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain(subjectPart);
  });

  // a language of their own always wins over the shop's: it is enabled, this person took it
  it("still goes in the person's own language when they have one", async () => {
    await setShopLocale('uk');

    const user = await createUser({ email: uniqueEmail('mail-locale'), locale: 'es' });
    userIds.push(user.id);
    const mails = watchMail();

    const res = await forgot(user.email);

    expect(res.statusCode).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('Restablece tu contraseña');
  });
});

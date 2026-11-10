import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { watchMail, watchNewsletterMail } from '../../../helpers/mail.js';
import { arrange, forget, journalOf, rowsOf } from '../../../helpers/newsletterApi.js';
import { inOwnerTx } from '../../../helpers/ownerDb.js';

import type { SubscriptionStatus } from '../../../helpers/newsletterDb.js';

// PUT /api/root/shop-settings and PUT /api/root/shop-settings/:key with enabledLocales: a language
// root turns off is taken from the accounts and from the subscriptions of the newsletters that have
// it, in the same transaction that writes the setting (the people are mailed in the language of the
// shop from then on). The language that comes back brings no one back and no mail goes out. The
// numbers root sees before turning one off are in localeCounts.shopwide.test.ts
// *.shopwide.test.ts: the languages of the shop are one for every test file running next to it, this
// file runs alone while it runs (tests/setup/integration.shopState.ts) and turns every language on
// again at the end

const ALL = ['en', 'uk', 'es'];

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let plainAdmin: TestUser;
const userIds: number[] = [];
const emails: string[] = [];

const newUser = async (locale: string | null = null, role: 'USER' | 'ADMIN' | 'ROOT' = 'USER') => {
  const user = await createUser({ role, ...(locale ? { locale } : {}) });
  userIds.push(user.id);
  return user;
};

// a subscription of the form with a language; its address is forgotten at the end
const formSubscription = async (locale: string | null, status: SubscriptionStatus = 'active') => {
  const made = await arrange({ source: 'form', locale, status });
  emails.push(made.email);
  return made;
};

// a subscription of an account (the address is the address of the account)
const accountSubscription = async (
  user: TestUser,
  locale: string | null,
  status: SubscriptionStatus = 'active',
) => {
  const made = await arrange({
    source: 'account',
    userId: user.id,
    email: user.email,
    locale,
    status,
  });
  emails.push(made.email);
  return made;
};

const currentValues = async () =>
  (
    await app.inject({
      method: 'GET',
      url: '/api/admin/shop-settings',
      headers: { cookie: accessCookie(root) },
    })
  ).json();

// every current value but the logo, as PUT takes them
const writableValues = async () => {
  const { logoUrl: _logoUrl, ...rest } = await currentValues();
  return rest;
};

const put = async (enabledLocales: string[], more: Record<string, unknown> = {}) =>
  app.inject({
    method: 'PUT',
    url: '/api/root/shop-settings',
    headers: withCsrf(csrf, accessCookie(root)),
    payload: { ...(await writableValues()), enabledLocales, ...more },
  });

const putOne = (key: string, value: unknown) =>
  app.inject({
    method: 'PUT',
    url: `/api/root/shop-settings/${key}`,
    headers: withCsrf(csrf, accessCookie(root)),
    payload: { value },
  });

const rowCount = () => asAdmin((tx) => tx.shopSetting.count());

const currentRows = (key: string) =>
  asAdmin((tx) =>
    tx.shopSetting.findFirst({ where: { key }, orderBy: { id: 'desc' }, select: { value: true } }),
  );

const accountLocale = async (user: TestUser) =>
  (
    await asAdmin((tx) =>
      tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { locale: true } }),
    )
  ).locale;

const subscriptionLocale = async (email: string) => (await rowsOf(email))[0]!.locale;

const resetLines = async (email: string) =>
  (await journalOf(email)).filter((line) => line.event === 'locale_reset');

// the language of the shop as this file found it
let foundShopLocale: string;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await newUser(null, 'ROOT');
  plainAdmin = await newUser(null, 'ADMIN');
  foundShopLocale = (await currentValues()).shopLocale;
  // the rows hold what this file sees (the baseline of the tests is in its memory only), with every
  // language turned on
  expect((await put(ALL)).statusCode).toBe(200);
});

// every language is on again after each test, whatever the test did: the next one starts from it
afterEach(async () => {
  await put(ALL, { shopLocale: foundShopLocale });
});

afterAll(async () => {
  try {
    await put(ALL, { shopLocale: foundShopLocale });
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('turning a language off', () => {
  it('leaves the accounts and the subscriptions that had it with no language, and only them', async () => {
    const ukAccount = await newUser('uk');
    const esAccount = await newUser('es');
    const enAccount = await newUser('en');
    const plainAccount = await newUser(null);
    const accountUk = await accountSubscription(ukAccount, 'uk');
    const accountEs = await accountSubscription(esAccount, 'es');
    const formUk = await formSubscription('uk');
    const formEs = await formSubscription('es');
    const formNone = await formSubscription(null);

    const res = await put(['en', 'es']);

    expect(res.statusCode).toBe(200);
    expect(res.json().enabledLocales).toEqual(['en', 'es']);
    expect(await accountLocale(ukAccount)).toBeNull();
    expect(await accountLocale(esAccount)).toBe('es');
    expect(await accountLocale(enAccount)).toBe('en');
    expect(await accountLocale(plainAccount)).toBeNull();
    expect(await subscriptionLocale(accountUk.email)).toBeNull();
    expect(await subscriptionLocale(formUk.email)).toBeNull();
    expect(await subscriptionLocale(accountEs.email)).toBe('es');
    expect(await subscriptionLocale(formEs.email)).toBe('es');
    expect(await subscriptionLocale(formNone.email)).toBeNull();

    // the answer the account itself reads
    const me = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie: accessCookie(ukAccount) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).not.toHaveProperty('locale');

    // one line of the journal for each subscription that changed, from the admin, naming root
    for (const reset of [accountUk, formUk]) {
      expect(await resetLines(reset.email)).toEqual([
        expect.objectContaining({
          event: 'locale_reset',
          place: 'admin',
          actorId: root.id,
          locale: null,
          ip: null,
          userAgent: null,
        }),
      ]);
    }
    for (const kept of [accountEs, formEs, formNone]) {
      expect(await resetLines(kept.email)).toEqual([]);
    }
  });

  it('takes both when two languages are turned off at once', async () => {
    const ukAccount = await newUser('uk');
    const esAccount = await newUser('es');
    const formUk = await formSubscription('uk');
    const formEs = await formSubscription('es');
    const formEn = await formSubscription('en');

    const res = await put(['en']);

    expect(res.statusCode).toBe(200);
    expect(await accountLocale(ukAccount)).toBeNull();
    expect(await accountLocale(esAccount)).toBeNull();
    expect(await subscriptionLocale(formUk.email)).toBeNull();
    expect(await subscriptionLocale(formEs.email)).toBeNull();
    expect(await subscriptionLocale(formEn.email)).toBe('en');
    expect(await resetLines(formUk.email)).toHaveLength(1);
    expect(await resetLines(formEs.email)).toHaveLength(1);
  });

  it('takes the language off a subscription that waits, is paused or stopped, but not off one that ended', async () => {
    const waiting = await formSubscription('uk', 'pending');
    const paused = await formSubscription('uk', 'paused_complaint');
    const stopped = await formSubscription('uk', 'stopped_bounce');
    const ended = await formSubscription('uk', 'ended');

    expect((await put(['en', 'es'])).statusCode).toBe(200);

    for (const touched of [waiting, paused, stopped]) {
      expect(await subscriptionLocale(touched.email)).toBeNull();
    }
    // an ended subscription is the proof of a consent: it keeps what it was
    expect(await subscriptionLocale(ended.email)).toBe('uk');
    expect(await resetLines(ended.email)).toEqual([]);
  });

  it('does it together with another setting that changes in the same write', async () => {
    const ukAccount = await newUser('uk');
    const shopName = `Reset ${Date.now()}`;
    const before = await currentValues();

    const res = await put(['en', 'es'], { shopName });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ shopName, enabledLocales: ['en', 'es'] });
    expect(await accountLocale(ukAccount)).toBeNull();

    // the name goes back as it was, the mails of the files after this one name the shop by it
    expect((await put(ALL, { shopName: before.shopName })).statusCode).toBe(200);
  });

  it('does not touch anyone when a language is added, or when the set stays as it is', async () => {
    expect((await put(['en', 'es'])).statusCode).toBe(200);
    const esAccount = await newUser('es');
    const formEs = await formSubscription('es');
    const total = await rowCount();

    // a language is added
    expect((await put(ALL)).statusCode).toBe(200);
    expect(await accountLocale(esAccount)).toBe('es');
    expect(await subscriptionLocale(formEs.email)).toBe('es');

    // the same set again: no row, no change
    const rows = await rowCount();
    expect(rows).toBe(total + 1);
    expect((await put(ALL)).statusCode).toBe(200);
    expect(await rowCount()).toBe(rows);
    expect(await accountLocale(esAccount)).toBe('es');
    expect(await resetLines(formEs.email)).toEqual([]);
  });

  it('compares with the rows the shop holds, so a set that was already without the language resets nobody', async () => {
    expect((await put(['en', 'es'])).statusCode).toBe(200);
    // a person who still has "uk" (a row written by hand while "uk" was off)
    const strayAccount = await newUser('uk');
    const strayForm = await formSubscription('uk');

    const again = await put(['en', 'es']);

    expect(again.statusCode).toBe(200);
    expect(await accountLocale(strayAccount)).toBe('uk');
    expect(await subscriptionLocale(strayForm.email)).toBe('uk');

    // the next write that removes nothing new is the same
    expect((await put(['en'])).statusCode).toBe(200);
    expect(await accountLocale(strayAccount)).toBe('uk');
  });

  it('is root alone: an admin cannot turn a language off, and nobody changes', async () => {
    const ukAccount = await newUser('uk');

    const refused = await app.inject({
      method: 'PUT',
      url: '/api/root/shop-settings/enabledLocales',
      headers: withCsrf(csrf, accessCookie(plainAdmin)),
      payload: { value: ['en', 'es'] },
    });

    expect(refused.statusCode).toBe(403);
    expect(await accountLocale(ukAccount)).toBe('uk');
    expect((await currentValues()).enabledLocales).toEqual(ALL);
  });

  it('is refused whole when the language of the shop would go, and nobody changes', async () => {
    const ukAccount = await newUser('uk');
    const formUk = await formSubscription('uk');
    const total = await rowCount();

    // the shop answers in Ukrainian: it cannot be turned off
    const shopInUk = await put(ALL, { shopLocale: 'uk' });
    expect(shopInUk.statusCode).toBe(200);
    const refused = await put(['en', 'es']);

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ errorCode: 'SHOP_LOCALE_NOT_ENABLED' });
    expect(await accountLocale(ukAccount)).toBe('uk');
    expect(await subscriptionLocale(formUk.email)).toBe('uk');
    expect(await rowCount()).toBe(total + 1);

    const back = await put(ALL, { shopLocale: foundShopLocale });
    expect(back.statusCode).toBe(200);
  });
});

describe('turning the language on again', () => {
  it('gives no one the language back and sends no mail', async () => {
    const ukAccount = await newUser('uk');
    const formUk = await formSubscription('uk');
    expect((await put(['en', 'es'])).statusCode).toBe(200);
    const orderMails = watchMail();
    const newsletterMails = watchNewsletterMail();

    const res = await put(ALL);

    expect(res.statusCode).toBe(200);
    expect(res.json().enabledLocales).toEqual(ALL);
    expect(await accountLocale(ukAccount)).toBeNull();
    expect(await subscriptionLocale(formUk.email)).toBeNull();
    expect(orderMails).toEqual([]);
    expect(newsletterMails).toEqual([]);

    // the journal says the language was taken, and never that it came back
    expect((await journalOf(formUk.email)).map((line) => line.event)).toEqual(['locale_reset']);
  });

  it('lets the person take the language again by choosing it', async () => {
    const ukAccount = await newUser('uk');
    expect((await put(['en', 'es'])).statusCode).toBe(200);
    expect((await put(ALL)).statusCode).toBe(200);

    const chosen = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: withCsrf(csrf, accessCookie(ukAccount)),
      payload: { locale: 'uk' },
    });

    expect(chosen.statusCode).toBe(200);
    expect(await accountLocale(ukAccount)).toBe('uk');
  });
});

describe('when the reset cannot be done', () => {
  // The step of the database is made to fail for one account (a trigger the test puts on the table
  // for the length of the test): the write of the setting and the reset are one transaction, so the
  // refusal leaves the setting, the memory of the server, the accounts and the subscriptions as they were
  it('changes nothing: not the setting, not the memory of the server, not a person', async () => {
    const failing = await newUser('uk');
    const other = await newUser('uk');
    const formUk = await formSubscription('uk');
    const total = await rowCount();
    const rowBefore = await currentRows('enabledLocales');

    await inOwnerTx(
      async (db) => {
        await db.rows(`
          create function cartlify.test_fail_locale_reset() returns trigger
          language plpgsql as $$ begin raise exception 'TEST_LOCALE_RESET_FAILS'; end $$`);
        await db.rows(`
          create trigger test_fail_locale_reset before update of locale on cartlify.users
          for each row when (old.id = ${failing.id} and new.locale is null)
          execute function cartlify.test_fail_locale_reset()`);
      },
      { commit: true },
    );

    try {
      const res = await put(['en', 'es']);

      expect(res.statusCode).toBe(500);
      takeLogs({ msg: 'request failed' });
      // nothing of it is kept: the rows, the answer of the server, the people
      expect(await rowCount()).toBe(total);
      expect(await currentRows('enabledLocales')).toEqual(rowBefore);
      expect((await currentValues()).enabledLocales).toEqual(ALL);
      expect(await accountLocale(failing)).toBe('uk');
      expect(await accountLocale(other)).toBe('uk');
      expect(await subscriptionLocale(formUk.email)).toBe('uk');
      expect(await resetLines(formUk.email)).toEqual([]);
    } finally {
      await inOwnerTx(
        async (db) => {
          await db.rows('drop trigger if exists test_fail_locale_reset on cartlify.users');
          await db.rows('drop function if exists cartlify.test_fail_locale_reset()');
        },
        { commit: true },
      );
    }

    // with the step working again the same write goes through whole
    const done = await put(['en', 'es']);
    expect(done.statusCode).toBe(200);
    expect(await accountLocale(failing)).toBeNull();
    expect(await accountLocale(other)).toBeNull();
    expect(await subscriptionLocale(formUk.email)).toBeNull();
  });
});

// The setting written on its own keeps only the rows of the shop and what it is given, so the
// memory of the server loses the baseline of the tests: these cases come last in the file
describe('turning a language off with the one setting written on its own', () => {
  it('does the same as the write of every setting', async () => {
    const ukAccount = await newUser('uk');
    const formUk = await formSubscription('uk');

    const res = await putOne('enabledLocales', ['en', 'es']);

    expect(res.statusCode).toBe(200);
    expect(res.json().enabledLocales).toEqual(['en', 'es']);
    expect(await accountLocale(ukAccount)).toBeNull();
    expect(await subscriptionLocale(formUk.email)).toBeNull();
    expect(await resetLines(formUk.email)).toHaveLength(1);

    await putOne('enabledLocales', ALL);
  });
});

// The subscriptions of the file go in a test, not in afterAll: the lock of the shop (tests/setup/
// integration.shopState.ts) is let go before the afterAll of a file, and the file after it that counts
// every subscription of the shop would meet rows that vanish while it counts
describe('the end of the file', () => {
  it('removes the subscriptions it made', async () => {
    await forget(emails);

    for (const email of emails) expect(await rowsOf(email)).toEqual([]);
  });
});

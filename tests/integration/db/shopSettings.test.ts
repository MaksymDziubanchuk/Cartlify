import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// shop_settings: one setting of the data of the shop a row, the value one key took, added by
// root, or by the system to fill in the default of a setting with no row yet. A row is never
// changed or removed; the current value of a key is its latest row; the shape of a value is
// checked by its key (db/06, shop_settings_value_chk). All in transactions that roll back: no
// other file sees a row made here

let admin: TestUser;
let root: TestUser;
let other: TestUser;

beforeAll(async () => {
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  other = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, root.id, other.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const as = (user: TestUser): Actor => ({ role: user.role, userId: user.id });
const SYSTEM: Actor = { role: 'ADMIN', userId: null };

type Written = { id: number; key: string; value: unknown; setById: number | null };

// a row of a setting, its value given as json text
const write = (db: DbSession, key: string, value: string, setById: number | null) =>
  db.attempt<Written>(
    `insert into cartlify.shop_settings (key, value, "setById")
     values ($1, $2::jsonb, $3)
     returning id, key, value, "setById"`,
    key,
    value,
    setById,
  );

describe('shop_settings rows', () => {
  it('lets root write a setting in their own name, the time the database own', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const written = await db.attempt<Written & { createdAt: Date }>(
        `insert into cartlify.shop_settings (key, value, "setById", "createdAt")
         values ('shopName', '"Cartlify"', $1, '2000-01-01')
         returning id, key, value, "setById", "createdAt"`,
        root.id,
      );
      const [{ now }] = await db.rows<{ now: Date }>(
        `select (clock_timestamp() at time zone 'UTC') as now`,
      );
      return { written, now };
    });

    expect(result.written.ok && result.written.rows[0]).toMatchObject({
      key: 'shopName',
      value: 'Cartlify',
      setById: root.id,
    });
    // the time of a row is the database's, not the one the insert named
    const createdAt = result.written.ok ? result.written.rows[0]!.createdAt : new Date(0);
    expect(Math.abs(createdAt.getTime() - result.now.getTime())).toBeLessThan(60_000);
  });

  it('lets the system write a setting with no author', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(SYSTEM);
      return write(db, 'reservationMinutes', '15', null);
    });

    expect(result.ok && result.rows[0]).toMatchObject({ key: 'reservationMinutes', setById: null });
  });

  it("refuses root writing in another root's name, and the system writing with an author", async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const forOther = await write(db, 'shopName', '"Other"', other.id);
      await db.as(SYSTEM);
      const systemNamed = await write(db, 'shopName', '"System"', root.id);
      return { forOther, systemNamed };
    });

    expect(result.forOther.ok).toBe(false);
    expect(result.systemNamed.ok).toBe(false);
  });

  it('refuses a write of a signed-in admin, a buyer or a guest', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      const byAdmin = await write(db, 'shopName', '"Admin"', admin.id);
      await db.as(null);
      const byNobody = await write(db, 'shopName', '"Nobody"', null);
      return { byAdmin, byNobody };
    });

    expect(result.byAdmin.ok).toBe(false);
    expect(result.byNobody.ok).toBe(false);
  });

  it('never lets a row be changed or removed, by root or by the system', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const made = await write(db, 'shopName', '"Before"', root.id);
      const id = made.ok ? made.rows[0]!.id : -1;

      const updated = await db.attempt(
        `update cartlify.shop_settings set value = '"After"' where id = $1`,
        id,
      );
      const deleted = await db.attempt(`delete from cartlify.shop_settings where id = $1`, id);

      await db.as(SYSTEM);
      const updatedBySystem = await db.attempt(
        `update cartlify.shop_settings set value = '"After"' where id = $1`,
        id,
      );

      return { made, updated, deleted, updatedBySystem };
    });

    expect(result.made.ok).toBe(true);
    // RLS already hides the row from UPDATE/DELETE (no row matched, no error): the append-only
    // guard trigger of db/05 only matters for a role RLS would not stop, such as a superuser
    expect(result.updated.ok && result.updated.rows).toEqual([]);
    expect(result.deleted.ok && result.deleted.rows).toEqual([]);
    expect(result.updatedBySystem.ok && result.updatedBySystem.rows).toEqual([]);
  });

  it('lets root and a signed-in admin read every row, the latest of a key its current value', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const first = await write(db, 'emailFromName', '"First"', root.id);
      const second = await write(db, 'emailFromName', '"Second"', root.id);
      const since = first.ok ? first.rows[0]!.id : -1;

      const current = `select distinct on (key) key, value from cartlify.shop_settings
        where key = 'emailFromName' order by key, id desc`;
      const mine = `select value from cartlify.shop_settings where id >= $1 order by id`;

      const byRoot = await db.rows<{ value: unknown }>(mine, since);
      const currentByRoot = await db.rows<{ value: unknown }>(current);

      await db.as(as(admin));
      const byAdmin = await db.rows<{ value: unknown }>(mine, since);

      return { second, byRoot, currentByRoot, byAdmin };
    });

    expect(result.second.ok).toBe(true);
    expect(result.byRoot.map((row) => row.value)).toEqual(['First', 'Second']);
    expect(result.byAdmin.map((row) => row.value)).toEqual(['First', 'Second']);
    expect(result.currentByRoot).toEqual([{ key: 'emailFromName', value: 'Second' }]);
  });
});

// the shape of each value by its key (shop_setting_value_valid, db/05); the rules between
// settings are the server's (a row cannot see the rows of the other keys)
describe('shop_settings values', () => {
  const attempt = (key: string, value: string) =>
    inRolledBackTx(async (db) => {
      await db.as(as(root));
      return write(db, key, value, root.id);
    });

  it.each([
    ['deliveryMethods', '["manual","pickup"]'],
    ['deliveryMethods', '[]'],
    ['deliveryFlatPrice', '4.99'],
    ['deliveryFlatPrice', 'null'],
    ['deliveryFreeFrom', '99999999.99'],
    ['deliveryCountries', '["UA","PL"]'],
    ['pickupAddress', '""'],
    ['pickupHours', '"Mon-Fri 09:00-18:00"'],
    ['shopName', '"Cartlify"'],
    ['emailReplyTo', '"help@cartlify.test"'],
    ['logoUrl', 'null'],
    ['logoPublicId', '"cartlify/shop/logo/abc"'],
    ['reservationMinutes', '15'],
    ['stripePageMinutes', '30'],
    ['reviewCheckEnabled', 'false'],
    ['avatarRemovalsLimit', '5'],
    ['withdrawalGraceDays', '0'],
    ['withdrawalGraceDays', '30'],
    ['newsletterLimitCount', '1'],
    ['newsletterLimitCount', '100'],
    ['newsletterLimitDays', '1'],
    ['newsletterLimitDays', '365'],
    ['shopLocale', '"uk"'],
    ['enabledLocales', '["en","uk"]'],
    ['newsletterTrustedDomains', '[]'],
    ['newsletterTrustedDomains', '["example.com"]'],
    ['newsletterTrustedDomains', '["shop.example.com","cdn.example.org","a-b.example.co.uk"]'],
    ['newsletterTrustedDomains', '["xn--80ak6aa92e.com","example.xn--p1ai"]'],
    ['newsletterTrustedDomains', '["1.example.com"]'],
    [
      'newsletterTrustedDomains',
      JSON.stringify(Array.from({ length: 50 }, (_, index) => `site${index}.example.com`)),
    ],
    ['newsletterFromName', '""'],
    ['newsletterFromName', '"Cartlify News"'],
    ['newsletterFromName', JSON.stringify('Caf\u00e9 \u2615 shop')],
    ['newsletterFromName', JSON.stringify('x'.repeat(100))],
    ['sellerLegalName', 'null'],
    ['sellerPhone', '"+380501234567"'],
  ])('takes %s = %s', async (key, value) => {
    expect((await attempt(key, value)).ok).toBe(true);
  });

  it.each([
    ['a key the server does not know', 'shopColor', '"violet"'],
    ['a delivery method the app does not know', 'deliveryMethods', '["manual","courier"]'],
    ['a method named twice', 'deliveryMethods', '["manual","manual"]'],
    ['a list that is no list', 'deliveryMethods', '"manual"'],
    ['a price of zero', 'deliveryFlatPrice', '0'],
    ['a price below the cent', 'deliveryFlatPrice', '4.995'],
    ['a price over what an amount holds', 'deliveryFreeFrom', '100000000'],
    ['a price as text', 'deliveryFlatPrice', '"4.99"'],
    ['a country that is not two capital letters', 'deliveryCountries', '["ua"]'],
    ['a country named twice', 'deliveryCountries', '["UA","UA"]'],
    ['an address over 300 characters', 'pickupAddress', JSON.stringify('x'.repeat(301))],
    ['a name of the shop that is null', 'shopName', 'null'],
    ['an empty logo', 'logoUrl', '""'],
    ['reservation minutes of zero', 'reservationMinutes', '0'],
    ['reservation minutes that are no whole number', 'reservationMinutes', '15.5'],
    ['a Stripe page under 30 minutes', 'stripePageMinutes', '20'],
    ['a check of reviews that is no true or false', 'reviewCheckEnabled', '"yes"'],
    ['a limit of zero', 'reviewRemovalsLimit', '0'],
    ['days of grace over 30', 'withdrawalGraceDays', '31'],
    ['a newsletter limit of no campaigns', 'newsletterLimitCount', '0'],
    ['a newsletter limit over 100 campaigns', 'newsletterLimitCount', '101'],
    ['a newsletter limit that is no whole number', 'newsletterLimitCount', '2.5'],
    ['a newsletter limit as text', 'newsletterLimitCount', '"2"'],
    ['a newsletter limit that is null', 'newsletterLimitCount', 'null'],
    ['a newsletter window of no days', 'newsletterLimitDays', '0'],
    ['a newsletter window over 365 days', 'newsletterLimitDays', '366'],
    ['a newsletter window that is no whole number', 'newsletterLimitDays', '7.5'],
    ['a newsletter window as text', 'newsletterLimitDays', '"7"'],
    ['a language not of two lower-case letters', 'shopLocale', '"EN"'],
    ['trusted domains that are no list', 'newsletterTrustedDomains', '"example.com"'],
    ['trusted domains that are null', 'newsletterTrustedDomains', 'null'],
    ['a trusted domain that is no text', 'newsletterTrustedDomains', '[1]'],
    ['a trusted domain in capitals', 'newsletterTrustedDomains', '["Example.com"]'],
    ['a trusted domain with a scheme', 'newsletterTrustedDomains', '["https://example.com"]'],
    ['a trusted domain with a path', 'newsletterTrustedDomains', '["example.com/shop"]'],
    ['a trusted domain with a port', 'newsletterTrustedDomains', '["example.com:8080"]'],
    ['a trusted domain with a wildcard', 'newsletterTrustedDomains', '["*.example.com"]'],
    ['a trusted domain of one label', 'newsletterTrustedDomains', '["localhost"]'],
    ['a trusted domain with a dot at the end', 'newsletterTrustedDomains', '["example.com."]'],
    ['a trusted domain with an empty label', 'newsletterTrustedDomains', '["a..example.com"]'],
    [
      'a trusted domain whose label starts with a hyphen',
      'newsletterTrustedDomains',
      '["-a.example.com"]',
    ],
    [
      'a trusted domain whose label ends with a hyphen',
      'newsletterTrustedDomains',
      '["a-.example.com"]',
    ],
    ['a trusted domain with a space', 'newsletterTrustedDomains', '["exa mple.com"]'],
    ['a trusted domain with an underscore', 'newsletterTrustedDomains', '["a_b.example.com"]'],
    [
      'a trusted domain with a letter that is no ascii',
      'newsletterTrustedDomains',
      JSON.stringify(['\u0435xample.com']),
    ],
    ['a trusted domain with a top level of digits', 'newsletterTrustedDomains', '["example.123"]'],
    [
      'a trusted domain whose label is over 63 characters',
      'newsletterTrustedDomains',
      JSON.stringify([`${'a'.repeat(64)}.example.com`]),
    ],
    [
      'a trusted domain over 253 characters',
      'newsletterTrustedDomains',
      JSON.stringify([`${Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')}.example.com`]),
    ],
    ['a trusted domain named twice', 'newsletterTrustedDomains', '["example.com","example.com"]'],
    [
      'more than fifty trusted domains',
      'newsletterTrustedDomains',
      JSON.stringify(Array.from({ length: 51 }, (_, index) => `site${index}.example.com`)),
    ],
    [
      'a name of the sender over 100 characters',
      'newsletterFromName',
      JSON.stringify('x'.repeat(101)),
    ],
    ['a name of the sender that is null', 'newsletterFromName', 'null'],
    ['a name of the sender that is a number', 'newsletterFromName', '5'],
    ['a name of the sender on two lines', 'newsletterFromName', JSON.stringify('Cartlify\nNews')],
    ['a name of the sender with a tab', 'newsletterFromName', JSON.stringify('Cartlify\tNews')],
    [
      'a name of the sender with a carriage return',
      'newsletterFromName',
      JSON.stringify('Cartlify\rNews'),
    ],
    [
      'a name of the sender with a control character',
      'newsletterFromName',
      JSON.stringify('Cartlify\u0007'),
    ],
    [
      'a name of the sender with the delete character',
      'newsletterFromName',
      JSON.stringify('Cartlify\u007f'),
    ],
    ['a language named twice', 'enabledLocales', '["en","en"]'],
    ['a tax id over 50 characters', 'sellerTaxId', JSON.stringify('1'.repeat(51))],
  ])('refuses %s', async (_case, key, value) => {
    expect(await attempt(key, value)).toMatchObject({ ok: false, code: '23514' });
  });
});

describe('users.locale', () => {
  it('keeps a language to two lower-case letters, or empty', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: admin.id });
      const bad = await db.attempt(
        `update cartlify.users set locale = $1 where id = $2`,
        'EN-us',
        admin.id,
      );
      const cleared = await db.attempt(
        `update cartlify.users set locale = $1 where id = $2`,
        null,
        admin.id,
      );
      return { bad, cleared };
    });

    expect(result.bad).toMatchObject({ ok: false, code: '23514' });
    expect(result.cleared.ok).toBe(true);
  });
});

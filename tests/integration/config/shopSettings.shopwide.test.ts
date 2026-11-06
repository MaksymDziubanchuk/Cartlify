import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import {
  loadShopSettings,
  missingShopSettingsFields,
  publicShopSettings,
  shopSettings,
  writeShopSettings,
  WRITABLE_SHOP_SETTINGS_FIELDS,
  type WritableShopSettings,
} from '@config/shopSettings.js';

import { startApp, stopApp } from '../../helpers/app.js';
import { asAdmin } from '../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// the module behind the routes of the data of the shop: the current value of each setting in
// memory (the latest row of its key), the defaults the server writes for a setting with no row, a
// row for each setting a write changes. The routes are tested in api/shopSettings; this is the
// module alone. *.shopwide.test.ts: its writes change the shop for every file (the name, the
// countries, the seller, the reply-to), so it runs alone (tests/setup/integration.shopState.ts)
// and writes back at the end what it found

let root: TestUser;
// the data of the shop as the rows hold it (loadShopSettings reads them itself, without the
// baseline of the tests startApp lays over it)
let found: WritableShopSettings;

const writable = (): WritableShopSettings => {
  const current = shopSettings();
  return Object.fromEntries(
    WRITABLE_SHOP_SETTINGS_FIELDS.map((key) => [key, current[key]]),
  ) as WritableShopSettings;
};

beforeAll(async () => {
  await startApp();
  root = await createUser({ role: 'ROOT' });
  await loadShopSettings();
  found = writable();
});

afterAll(async () => {
  try {
    await writeShopSettings({ actorId: root.id, values: found });
    await closeSessions([root.id]);
  } finally {
    await stopApp();
  }
});

const rowsOf = (key: string) =>
  asAdmin((db) =>
    db.shopSetting.findMany({
      where: { key },
      orderBy: { id: 'asc' },
      select: { id: true, value: true, setById: true },
    }),
  );

const rowCount = () => asAdmin((db) => db.shopSetting.count());

describe('loadShopSettings()', () => {
  // every setting with a default has a row once the server started; one without stays rowless
  it('writes a row of the system for a setting with a default and no row, and only once', async () => {
    await loadShopSettings();
    const before = await rowCount();

    await loadShopSettings();

    expect(await rowCount()).toBe(before);
    for (const key of ['deliveryMethods', 'shopName', 'reservationMinutes', 'enabledLocales']) {
      expect((await rowsOf(key)).length).toBeGreaterThan(0);
    }
  });

  it('gives a setting nobody wrote its default, and one without a default as empty', async () => {
    const values = shopSettings();

    expect(values.reservationMinutes).toBeGreaterThan(0);
    expect(values.stripePageMinutes).toBeGreaterThanOrEqual(30);
    expect(values.shopLocale).toMatch(/^[a-z]{2}$/);
    expect(values.enabledLocales).toContain(values.shopLocale);
    expect(Array.isArray(values.deliveryCountries)).toBe(true);
  });

  it('keeps the seller fields and the countries out of the public view, and names only what it needs', () => {
    const pub = publicShopSettings();

    expect(Object.keys(pub).sort()).toEqual(
      [
        'shopName',
        'logoUrl',
        'shopLocale',
        'enabledLocales',
        'sellerLegalName',
        'sellerAddress',
        'sellerTaxId',
        'sellerEmail',
        'sellerPhone',
      ].sort(),
    );
    expect(pub).not.toHaveProperty('deliveryCountries');
    expect(pub).not.toHaveProperty('emailReplyTo');
  });
});

describe('writeShopSettings()', () => {
  it('adds one row for the one setting that changes, in the name of root', async () => {
    const before = await rowsOf('emailFromName');
    const total = await rowCount();
    const name = `Sender ${Date.now()}`;

    const written = await writeShopSettings({
      actorId: root.id,
      values: { ...writable(), emailFromName: name },
    });

    const after = await rowsOf('emailFromName');
    expect(written.emailFromName).toBe(name);
    expect(shopSettings().emailFromName).toBe(name);
    expect(await rowCount()).toBe(total + 1);
    expect(after.slice(before.length)).toEqual([
      expect.objectContaining({ value: name, setById: root.id }),
    ]);
  });

  it('adds no row for a setting given as it already is', async () => {
    const total = await rowCount();

    await writeShopSettings({ actorId: root.id, values: writable() });
    await writeShopSettings({
      actorId: root.id,
      values: { shopName: shopSettings().shopName },
    });

    expect(await rowCount()).toBe(total);
  });

  it('keeps every other setting as it was when one changes', async () => {
    const before = shopSettings();

    await writeShopSettings({ actorId: root.id, values: { sellerLegalName: 'Cartlify LLC' } });

    expect(shopSettings()).toEqual({ ...before, sellerLegalName: 'Cartlify LLC' });
  });

  // the rules between settings run on the values the write would leave: a refusal writes nothing
  it('writes nothing when the check of the result refuses it', async () => {
    const total = await rowCount();
    const before = shopSettings();

    await expect(
      writeShopSettings({
        actorId: root.id,
        values: { shopName: 'Refused', deliveryFlatPrice: 5 },
        check: () => {
          throw new Error('refused');
        },
      }),
    ).rejects.toThrow('refused');

    expect(await rowCount()).toBe(total);
    expect(shopSettings()).toEqual(before);
  });

  it('lists the settings with no default that are still empty', async () => {
    await writeShopSettings({
      actorId: root.id,
      values: {
        sellerLegalName: null,
        sellerAddress: null,
        sellerTaxId: null,
        sellerEmail: null,
        sellerPhone: null,
        deliveryCountries: [],
        // loadShopSettings above read the rows of the database, its reply-to is the empty default
        emailReplyTo: 'help@cartlify.test',
      },
    });

    expect(missingShopSettingsFields().sort()).toEqual(
      [
        'deliveryCountries',
        // nobody uploaded a logo in this file
        'logoUrl',
        'sellerLegalName',
        'sellerAddress',
        'sellerTaxId',
        'sellerEmail',
        'sellerPhone',
      ].sort(),
    );

    await writeShopSettings({
      actorId: root.id,
      values: {
        sellerLegalName: 'Cartlify LLC',
        sellerAddress: 'Main St 1',
        sellerTaxId: '123456',
        sellerEmail: 'legal@cartlify.test',
        sellerPhone: '+380501234567',
        deliveryCountries: ['UA'],
      },
    });

    // logoUrl stays: nothing in this file uploads one
    expect(missingShopSettingsFields()).toEqual(['logoUrl']);
  });

  // the reply-to has a default, but an empty one: no mail goes out without it
  // (EMAIL_REPLY_TO_REQUIRED), so a blank one is named the way a setting with no default is
  it('names a blank reply-to, and stops once root sets one', async () => {
    await writeShopSettings({ actorId: root.id, values: { emailReplyTo: '  ' } });
    expect(missingShopSettingsFields()).toContain('emailReplyTo');

    await writeShopSettings({ actorId: root.id, values: { emailReplyTo: 'help@cartlify.test' } });
    expect(missingShopSettingsFields()).not.toContain('emailReplyTo');
  });
});

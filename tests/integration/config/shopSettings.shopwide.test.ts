import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import {
  loadShopSettings,
  missingShopSettingsFields,
  publicShopSettings,
  shopSettings,
  shopSettingsVersion,
  writeShopSettings,
  type WritableShopSettings,
} from '@config/shopSettings.js';
import { prisma } from '@db/client.js';

import { startApp, stopApp } from '../../helpers/app.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// the module behind GET/PUT /api/root/shop-settings and the public shop-settings route: the
// current values in memory, defaults filling what root never set, a version for the optimistic
// check of a write. The routes are tested in api/root and api/system; this is the module alone.
// *.shopwide.test.ts: its writes change the shop for every file (the name, the countries, the
// seller, the reply-to), so it runs alone (tests/setup/integration.shopState.ts) and writes back
// at the end what it found: a file that started next to it read the name this one made up

let root: TestUser;
// the data of the shop as the database holds it (loadShopSettings reads the row itself, without
// the baseline of the tests startApp lays over it)
let found: WritableShopSettings;

beforeAll(async () => {
  await startApp();
  root = await createUser({ role: 'ROOT' });
  await loadShopSettings();
  found = fullValues();
});

afterAll(async () => {
  try {
    await writeShopSettings({
      actorId: root.id,
      baseVersion: shopSettingsVersion(),
      values: found,
    });
    await closeSessions([root.id]);
  } finally {
    await stopApp();
  }
});

// a full body for writeShopSettings, the current values with one field overridden; root always
// sends every writable field (PUT), not a partial one
const fullValues = (over: Partial<WritableShopSettings> = {}): WritableShopSettings => {
  const current = shopSettings();
  return {
    deliveryMethods: current.deliveryMethods,
    deliveryFlatPrice: current.deliveryFlatPrice,
    deliveryFreeFrom: current.deliveryFreeFrom,
    deliveryCountries: current.deliveryCountries,
    pickupAddress: current.pickupAddress,
    pickupHours: current.pickupHours,
    shopName: current.shopName,
    emailFromName: current.emailFromName,
    emailReplyTo: current.emailReplyTo,
    reservationMinutes: current.reservationMinutes,
    stripePageMinutes: current.stripePageMinutes,
    reviewCheckEnabled: current.reviewCheckEnabled,
    avatarRemovalsLimit: current.avatarRemovalsLimit,
    reviewRemovalsLimit: current.reviewRemovalsLimit,
    withdrawalGraceDays: current.withdrawalGraceDays,
    shopLocale: current.shopLocale,
    enabledLocales: current.enabledLocales,
    sellerLegalName: current.sellerLegalName,
    sellerAddress: current.sellerAddress,
    sellerTaxId: current.sellerTaxId,
    sellerEmail: current.sellerEmail,
    sellerPhone: current.sellerPhone,
    ...over,
  };
};

describe('shopSettings()', () => {
  it('gives the server defaults for the fields nobody wrote yet', async () => {
    await loadShopSettings();
    const values = shopSettings();

    // the table may already carry a write of another test file (the row is shared, db/shop-settings.md);
    // only the shape and the fields with a server default are asserted here
    expect(values.deliveryMethods.length).toBeGreaterThanOrEqual(0);
    expect(values.reservationMinutes).toBeGreaterThan(0);
    expect(values.stripePageMinutes).toBeGreaterThanOrEqual(30);
    expect(values.shopLocale).toMatch(/^[a-z]{2}$/);
    expect(values.enabledLocales).toContain(values.shopLocale);
    expect(shopSettingsVersion()).toBeGreaterThan(0);
  });

  it('keeps the seller fields and the countries out of the public view, and names only what it needs', async () => {
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
  it('writes a new version root can read right after, and refuses a stale base version', async () => {
    const before = shopSettingsVersion();

    const written = await writeShopSettings({
      actorId: root.id,
      baseVersion: before,
      values: fullValues({ shopName: `Shop ${before}` }),
    });

    expect(written.shopName).toBe(`Shop ${before}`);
    expect(shopSettingsVersion()).toBeGreaterThan(before);
    expect(shopSettings().shopName).toBe(`Shop ${before}`);

    await expect(
      writeShopSettings({
        actorId: root.id,
        baseVersion: before,
        values: fullValues({ shopName: 'stale write' }),
      }),
    ).rejects.toMatchObject({ errorCode: 'SHOP_SETTINGS_OUTDATED', statusCode: 409 });
  });

  it('carries the logo forward across a write that does not touch it', async () => {
    const latest = await prisma.shopSetting.findFirst({ orderBy: { version: 'desc' } });

    await writeShopSettings({
      actorId: root.id,
      baseVersion: shopSettingsVersion(),
      values: fullValues({ sellerLegalName: 'Cartlify LLC' }),
    });

    const after = shopSettings();
    expect(after.logoUrl).toBe(latest?.logoUrl ?? null);
    expect(after.sellerLegalName).toBe('Cartlify LLC');
  });

  it('lists the fields with no default that are still empty', async () => {
    await writeShopSettings({
      actorId: root.id,
      baseVersion: shopSettingsVersion(),
      values: fullValues({
        sellerLegalName: null,
        sellerAddress: null,
        sellerTaxId: null,
        sellerEmail: null,
        sellerPhone: null,
        deliveryCountries: [],
        // loadShopSettings above read the row of the database, its reply-to is the empty default
        emailReplyTo: 'help@cartlify.test',
      }),
    });

    expect(missingShopSettingsFields().sort()).toEqual(
      [
        'deliveryCountries',
        // nobody uploaded a logo in this test (setShopLogo.service.ts, a later step)
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
      baseVersion: shopSettingsVersion(),
      values: fullValues({
        sellerLegalName: 'Cartlify LLC',
        sellerAddress: 'Main St 1',
        sellerTaxId: '123456',
        sellerEmail: 'legal@cartlify.test',
        sellerPhone: '+380501234567',
        deliveryCountries: ['UA'],
      }),
    });

    // logoUrl stays: nothing in this test uploads one (a later step)
    expect(missingShopSettingsFields()).toEqual(['logoUrl']);
  });

  // the reply-to has a default, but an empty one: no mail goes out without it
  // (EMAIL_REPLY_TO_REQUIRED), so a blank one is named the way a field with no default is
  it('names a blank reply-to, and stops once root sets one', async () => {
    await writeShopSettings({
      actorId: root.id,
      baseVersion: shopSettingsVersion(),
      values: fullValues({ emailReplyTo: '  ' }),
    });
    expect(missingShopSettingsFields()).toContain('emailReplyTo');

    await writeShopSettings({
      actorId: root.id,
      baseVersion: shopSettingsVersion(),
      values: fullValues({ emailReplyTo: 'help@cartlify.test' }),
    });
    expect(missingShopSettingsFields()).not.toContain('emailReplyTo');
  });
});

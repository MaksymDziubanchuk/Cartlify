import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';

import { AVAILABLE_LOCALES } from './locales.js';
import { isDeliveryMethodName, type DeliveryMethodName } from './deliveryMethods.js';

import type { UserId } from 'types/ids.js';

// The data of the shop (delivery, brand, reservation, moderation, withdrawal, languages, the
// seller, the logo), one setting a row in cartlify.shop_settings: a key and the value it took.
// Root adds a row for each setting they change, nobody changes or removes one, the current value
// of a setting is the latest row of its key (docs/shop-settings.md). The server keeps the current
// values (the defaults below filling a setting with no row) in memory and reads them from here
// everywhere a route used to read env; they are read at startup and inside every write
// (loadShopSettings, writeShopSettings).

export type ShopSettingsValues = {
  deliveryMethods: DeliveryMethodName[];
  deliveryFlatPrice: number | null;
  deliveryFreeFrom: number | null;
  deliveryCountries: string[];
  pickupAddress: string;
  pickupHours: string;

  shopName: string;
  emailFromName: string;
  emailReplyTo: string;
  logoUrl: string | null;
  logoPublicId: string | null;

  reservationMinutes: number;
  stripePageMinutes: number;

  reviewCheckEnabled: boolean;
  avatarRemovalsLimit: number;
  reviewRemovalsLimit: number;

  withdrawalGraceDays: number;

  // at most newsletterLimitCount campaigns in any window of newsletterLimitDays days
  newsletterLimitCount: number;
  newsletterLimitDays: number;
  // the name the newsletters are sent under; empty means emailFromName, then shopName
  newsletterFromName: string;
  // hosts (lower case) a text of a newsletter may link to besides the shop's own
  newsletterTrustedDomains: string[];

  shopLocale: string;
  enabledLocales: string[];

  sellerLegalName: string | null;
  sellerAddress: string | null;
  sellerTaxId: string | null;
  sellerEmail: string | null;
  sellerPhone: string | null;
};

export type ShopSettingKey = keyof ShopSettingsValues;

// every key a row may have, the same list the database checks (db/05, shop_setting_value_valid)
export const SHOP_SETTING_KEYS = [
  'deliveryMethods',
  'deliveryFlatPrice',
  'deliveryFreeFrom',
  'deliveryCountries',
  'pickupAddress',
  'pickupHours',
  'shopName',
  'emailFromName',
  'emailReplyTo',
  'logoUrl',
  'logoPublicId',
  'reservationMinutes',
  'stripePageMinutes',
  'reviewCheckEnabled',
  'avatarRemovalsLimit',
  'reviewRemovalsLimit',
  'withdrawalGraceDays',
  'newsletterLimitCount',
  'newsletterLimitDays',
  'newsletterFromName',
  'newsletterTrustedDomains',
  'shopLocale',
  'enabledLocales',
  'sellerLegalName',
  'sellerAddress',
  'sellerTaxId',
  'sellerEmail',
  'sellerPhone',
] as const satisfies readonly ShopSettingKey[];

// settings a buyer or a guest is shown (GET /api/shop-settings); delivery is its own route
// (GET /api/delivery/methods) and stays out of this list
export const PUBLIC_SHOP_SETTINGS_FIELDS = [
  'shopName',
  'logoUrl',
  'shopLocale',
  'enabledLocales',
  'sellerLegalName',
  'sellerAddress',
  'sellerTaxId',
  'sellerEmail',
  'sellerPhone',
] as const satisfies readonly ShopSettingKey[];

export type PublicShopSettings = Pick<
  ShopSettingsValues,
  (typeof PUBLIC_SHOP_SETTINGS_FIELDS)[number]
>;

// settings root sets with PUT /api/root/shop-settings and PUT /api/root/shop-settings/:key: every
// one but the logo, which its own routes write (src/routes/api/shopSettings/services/)
export const WRITABLE_SHOP_SETTINGS_FIELDS = [
  'deliveryMethods',
  'deliveryFlatPrice',
  'deliveryFreeFrom',
  'deliveryCountries',
  'pickupAddress',
  'pickupHours',
  'shopName',
  'emailFromName',
  'emailReplyTo',
  'reservationMinutes',
  'stripePageMinutes',
  'reviewCheckEnabled',
  'avatarRemovalsLimit',
  'reviewRemovalsLimit',
  'withdrawalGraceDays',
  'newsletterLimitCount',
  'newsletterLimitDays',
  'newsletterFromName',
  'newsletterTrustedDomains',
  'shopLocale',
  'enabledLocales',
  'sellerLegalName',
  'sellerAddress',
  'sellerTaxId',
  'sellerEmail',
  'sellerPhone',
] as const satisfies readonly ShopSettingKey[];

export type WritableShopSettingKey = (typeof WRITABLE_SHOP_SETTINGS_FIELDS)[number];

export type WritableShopSettings = Pick<ShopSettingsValues, WritableShopSettingKey>;

// the default of a setting the server gives until root sets it, written as a row of the system at
// the start of the server (loadShopSettings); a setting not here has none (NO_DEFAULT_VALUES)
const DEFAULTS: Partial<ShopSettingsValues> = {
  deliveryMethods: ['manual'],
  deliveryFlatPrice: null,
  deliveryFreeFrom: null,
  pickupAddress: '',
  pickupHours: '',
  shopName: 'Cartlify',
  emailFromName: '',
  emailReplyTo: '',
  reservationMinutes: 15,
  stripePageMinutes: 30,
  reviewCheckEnabled: true,
  avatarRemovalsLimit: 5,
  reviewRemovalsLimit: 5,
  withdrawalGraceDays: 4,
  newsletterLimitCount: 2,
  newsletterLimitDays: 7,
  newsletterFromName: '',
  newsletterTrustedDomains: [],
  shopLocale: 'en',
  // every language with a dictionary, until root turns some off (src/locales/*.json)
  enabledLocales: [...AVAILABLE_LOCALES],
};

// what a setting with no default reads as while root has not set it: no row is written for it.
// deliveryCountries blocks the routes that need it (confirming an order of the manual method); the
// rest only keep the shop from naming itself on its public pages and mails
// (missingShopSettingsFields)
const NO_DEFAULT_VALUES = {
  deliveryCountries: [],
  logoUrl: null,
  logoPublicId: null,
  sellerLegalName: null,
  sellerAddress: null,
  sellerTaxId: null,
  sellerEmail: null,
  sellerPhone: null,
} satisfies Partial<ShopSettingsValues>;

const NO_DEFAULT_FIELDS = [
  'deliveryCountries',
  'logoUrl',
  'sellerLegalName',
  'sellerAddress',
  'sellerTaxId',
  'sellerEmail',
  'sellerPhone',
] as const satisfies readonly (keyof typeof NO_DEFAULT_VALUES)[];

// settings with an empty default the shop cannot work with: no mail goes out without a reply-to
// (sendEmail.helper.ts refuses one, EMAIL_REPLY_TO_REQUIRED), so it is named with the settings
// that have no default at all
const REQUIRED_TEXT_FIELDS = ['emailReplyTo'] as const satisfies readonly (ShopSettingKey &
  keyof typeof DEFAULTS)[];

type CurrentRows = Map<ShopSettingKey, unknown>;

const isSettingKey = (key: string): key is ShopSettingKey =>
  (SHOP_SETTING_KEYS as readonly string[]).includes(key);

// the latest row of each key, in the transaction given (its context decides what it may read)
async function currentRowsOf(db: Prisma.TransactionClient): Promise<CurrentRows> {
  const rows = await db.$queryRaw<{ key: string; value: unknown }[]>`
    select distinct on (key) key, value
    from cartlify.shop_settings
    order by key, id desc
  `;

  return new Map(
    rows
      .filter((row) => isSettingKey(row.key))
      .map((row) => [row.key as ShopSettingKey, row.value]),
  );
}

// the values of the rows, a setting with no row reading as its default (or as empty, for one
// without a default)
function valuesOf(rows: CurrentRows): ShopSettingsValues {
  const fallback = { ...NO_DEFAULT_VALUES, ...DEFAULTS } as ShopSettingsValues;
  const values = { ...fallback };
  for (const [key, value] of rows) (values as Record<ShopSettingKey, unknown>)[key] = value;
  return values;
}

// a value as the json column takes it: null is the json null, not "no value"
const jsonOf = (value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// the languages a write takes away: the ones the rows held that the new set leaves out, each once, in
// the order the rows had them
export function removedLocalesOf(before: readonly string[], after: readonly string[]): string[] {
  return [...new Set(before)].filter((code) => !after.includes(code));
}

let cache: ShopSettingsValues | null = null;

// the current values, the defaults filling what root left empty; throws if nothing loaded them
// yet (loadShopSettings runs once at startup, src/index.ts and tests/helpers/app.ts)
export function shopSettings(): ShopSettingsValues {
  if (!cache) throw new Error('shop settings were not loaded (loadShopSettings)');
  return cache;
}

// sets the cache straight, no database: a unit test gives no startApp (loadShopSettings) to fill
// it, an integration test may still want one setting changed for itself without a real write
// (tests/helpers/shopSettings.ts). Production code never calls this, only writeShopSettings and
// writeShopLogo change the cache for real
export function setShopSettingsForTest(values: Partial<ShopSettingsValues> = {}): void {
  cache = { ...(cache ?? valuesOf(new Map())), ...values };
}

export function publicShopSettings(): PublicShopSettings {
  const values = shopSettings();
  const out = {} as PublicShopSettings;
  for (const key of PUBLIC_SHOP_SETTINGS_FIELDS) out[key] = values[key] as never;
  return out;
}

// the limit of the newsletters root set (2 campaigns in 7 days until root says otherwise): at most
// `count` campaigns may go out in any window of `days` days (checkSendingLimit)
export function newsletterLimit(): { count: number; days: number } {
  const values = shopSettings();
  return { count: values.newsletterLimitCount, days: values.newsletterLimitDays };
}

// the settings root has not set yet: the ones with no default of the server, and a required text
// still empty or blank (the shop_settings_incomplete alert and GET /api/admin/shop-settings/missing
// read this)
export function missingShopSettingsFields(): ShopSettingKey[] {
  const values = shopSettings();
  const noDefault = NO_DEFAULT_FIELDS.filter((key) => {
    const value = values[key];
    return value === null || (Array.isArray(value) && value.length === 0);
  });
  const blankText = REQUIRED_TEXT_FIELDS.filter((key) => !values[key].trim());
  return [...noDefault, ...blankText];
}

// reads the latest row of each key (the system context: this runs at startup, never for a request
// of a buyer) and fills the cache; a setting that has a default and no row yet gets one, written
// as the system (setById null), so the rows say what the shop runs with and a setting added to the
// code later is filled in the same way
export async function loadShopSettings(): Promise<void> {
  cache = await tx(async (db) => {
    await setAdminContext(db);
    const rows = await currentRowsOf(db);

    const missing = (Object.keys(DEFAULTS) as ShopSettingKey[]).filter((key) => !rows.has(key));
    if (missing.length) {
      await db.shopSetting.createMany({
        data: missing.map((key) => ({ key, value: jsonOf(DEFAULTS[key]), setById: null })),
      });
      for (const key of missing) rows.set(key, DEFAULTS[key]);
    }

    return valuesOf(rows);
  });
}

// a write of root: the settings given over the current values, the rules between settings checked
// on the result (check, a refusal throws and writes nothing), a row added for each setting whose
// value changes, none for one given as it already was. The writes of the data of the shop wait for
// each other (an advisory lock), so a check always sees the values the rows hold, not ones another
// write is about to change.
// A language the write takes out of enabledLocales (the rows held it, the new set does not) is taken
// from the people who had it in the same transaction: the accounts and the subscriptions of the
// newsletters that have it are left with none, and are mailed in the language of the shop. The step
// is a function of the database that reads the rows just written, so it comes after them, and a
// failure of it takes the write back with it (nothing is changed, the memory of the server is not
// either). A language that comes back brings no one back
async function writeSettings(args: {
  actorId: UserId;
  values: Partial<ShopSettingsValues>;
  check?: (next: ShopSettingsValues) => void;
}): Promise<{ settings: ShopSettingsValues; previous: ShopSettingsValues }> {
  const written = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: 'ROOT' });
    await db.$executeRaw`select pg_advisory_xact_lock(hashtext('cartlify.shop_settings'))`;

    const previous = valuesOf(await currentRowsOf(db));
    const settings = { ...previous, ...args.values };
    args.check?.(settings);

    const changed = (Object.keys(args.values) as ShopSettingKey[]).filter(
      (key) => !sameValue(previous[key], settings[key]),
    );
    if (changed.length) {
      await db.shopSetting.createMany({
        data: changed.map((key) => ({
          key,
          value: jsonOf(settings[key]),
          setById: Number(args.actorId),
        })),
      });
    }

    for (const locale of removedLocalesOf(previous.enabledLocales, settings.enabledLocales)) {
      await db.$executeRaw`select * from cartlify.newsletter_reset_locale(${locale})`;
    }

    return { settings, previous };
  });

  cache = written.settings;
  return written;
}

// root sets settings of the data of the shop, all of them (PUT /api/root/shop-settings) or one
// (PUT /api/root/shop-settings/:key); the logo has writeShopLogo
export async function writeShopSettings(args: {
  actorId: UserId;
  values: Partial<WritableShopSettings>;
  check?: (next: ShopSettingsValues) => void;
}): Promise<ShopSettingsValues> {
  return (await writeSettings(args)).settings;
}

// root sets the logo, or takes it away with null, null. The caller already moved the file to its
// place on Cloudinary (or has nothing to move, for a removal); the id of the file the shop had is
// given back, for the caller to delete once this write landed
export async function writeShopLogo(args: {
  actorId: UserId;
  logoUrl: string | null;
  logoPublicId: string | null;
}): Promise<{ settings: ShopSettingsValues; oldLogoPublicId: string | null }> {
  const { settings, previous } = await writeSettings({
    actorId: args.actorId,
    values: { logoUrl: args.logoUrl, logoPublicId: args.logoPublicId },
  });
  return { settings, oldLogoPublicId: previous.logoPublicId };
}

export { isDeliveryMethodName };

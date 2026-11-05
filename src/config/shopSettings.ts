import { getPgMessage, tx } from '@db/client.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { ConflictError } from '@utils/errors.js';

import { AVAILABLE_LOCALES } from './locales.js';
import { isDeliveryMethodName, type DeliveryMethodName } from './deliveryMethods.js';

import type { Prisma, ShopSetting } from '@prisma/client';
import type { UserId } from 'types/ids.js';

// The data of the shop (delivery, brand, reservation, moderation, withdrawal, languages, the
// seller): a version in cartlify.shop_settings, root writes a new one, nobody changes or removes
// one, the current one is the one with the highest "version". The server keeps the current one
// (as the defaults below fill it) in memory and reads it from here everywhere a route used to
// read env; it is refreshed at startup and after every write (loadShopSettings, docs/shop-settings.md).

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

  shopLocale: string;
  enabledLocales: string[];

  sellerLegalName: string | null;
  sellerAddress: string | null;
  sellerTaxId: string | null;
  sellerEmail: string | null;
  sellerPhone: string | null;
};

// fields a buyer or a guest is shown (GET /api/shop-settings); delivery is its own route
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
] as const satisfies readonly (keyof ShopSettingsValues)[];

export type PublicShopSettings = Pick<
  ShopSettingsValues,
  (typeof PUBLIC_SHOP_SETTINGS_FIELDS)[number]
>;

// fields root may set with PUT /api/root/shop-settings: every field but the logo, which its own
// route writes (src/routes/api/shopSettings/services/setShopLogo.service.ts), and the version root
// saw
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
  'shopLocale',
  'enabledLocales',
  'sellerLegalName',
  'sellerAddress',
  'sellerTaxId',
  'sellerEmail',
  'sellerPhone',
] as const satisfies readonly (keyof ShopSettingsValues)[];

export type WritableShopSettings = Pick<
  ShopSettingsValues,
  (typeof WRITABLE_SHOP_SETTINGS_FIELDS)[number]
>;

// the default of a field the server gives until root sets it; a field not here (deliveryCountries,
// the seller, the logo) has none: it stays empty until root sets it (missingShopSettingsFields,
// db/shop-settings.md)
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
  shopLocale: 'en',
  // every language with a dictionary, until root turns some off (src/locales/*.json)
  enabledLocales: [...AVAILABLE_LOCALES],
};

// fields with no default of the server: empty until root sets them. deliveryCountries blocks the
// routes that need it (confirming an order of the manual method); the rest only keep the shop from
// naming itself on its public pages and mails (missingShopSettingsFields)
const NO_DEFAULT_FIELDS = [
  'deliveryCountries',
  'logoUrl',
  'sellerLegalName',
  'sellerAddress',
  'sellerTaxId',
  'sellerEmail',
  'sellerPhone',
] as const satisfies readonly (keyof ShopSettingsValues)[];

type Row = Pick<ShopSetting, 'id' | 'version' | keyof ShopSettingsValues>;

const SELECT = {
  id: true,
  version: true,
  deliveryMethods: true,
  deliveryFlatPrice: true,
  deliveryFreeFrom: true,
  deliveryCountries: true,
  pickupAddress: true,
  pickupHours: true,
  shopName: true,
  emailFromName: true,
  emailReplyTo: true,
  logoUrl: true,
  logoPublicId: true,
  reservationMinutes: true,
  stripePageMinutes: true,
  reviewCheckEnabled: true,
  avatarRemovalsLimit: true,
  reviewRemovalsLimit: true,
  withdrawalGraceDays: true,
  shopLocale: true,
  enabledLocales: true,
  sellerLegalName: true,
  sellerAddress: true,
  sellerTaxId: true,
  sellerEmail: true,
  sellerPhone: true,
} satisfies Prisma.ShopSettingSelect;

// the values of a row, the defaults filling what it left empty
function valuesOf(row: Row | null): ShopSettingsValues {
  const get = <K extends keyof ShopSettingsValues>(key: K): ShopSettingsValues[K] => {
    const raw = row?.[key];
    if (raw !== null && raw !== undefined) return raw as ShopSettingsValues[K];
    return (DEFAULTS[key] ?? null) as ShopSettingsValues[K];
  };

  return {
    deliveryMethods: get('deliveryMethods'),
    deliveryFlatPrice: row?.deliveryFlatPrice != null ? Number(row.deliveryFlatPrice) : null,
    deliveryFreeFrom: row?.deliveryFreeFrom != null ? Number(row.deliveryFreeFrom) : null,
    deliveryCountries: get('deliveryCountries'),
    pickupAddress: get('pickupAddress'),
    pickupHours: get('pickupHours'),
    shopName: get('shopName'),
    emailFromName: get('emailFromName'),
    emailReplyTo: get('emailReplyTo'),
    logoUrl: get('logoUrl'),
    logoPublicId: get('logoPublicId'),
    reservationMinutes: get('reservationMinutes'),
    stripePageMinutes: get('stripePageMinutes'),
    reviewCheckEnabled: get('reviewCheckEnabled'),
    avatarRemovalsLimit: get('avatarRemovalsLimit'),
    reviewRemovalsLimit: get('reviewRemovalsLimit'),
    withdrawalGraceDays: get('withdrawalGraceDays'),
    shopLocale: get('shopLocale'),
    enabledLocales: get('enabledLocales'),
    sellerLegalName: get('sellerLegalName'),
    sellerAddress: get('sellerAddress'),
    sellerTaxId: get('sellerTaxId'),
    sellerEmail: get('sellerEmail'),
    sellerPhone: get('sellerPhone'),
  };
}

let cache: ShopSettingsValues | null = null;
let cacheVersion = 0;

// the current values, the defaults filling what root left empty; throws if nothing loaded them
// yet (loadShopSettings runs once at startup, src/index.ts and tests/helpers/app.ts)
export function shopSettings(): ShopSettingsValues {
  if (!cache) throw new Error('shop settings were not loaded (loadShopSettings)');
  return cache;
}

// the version of the row the cache was built from (0 before the first write exists)
export function shopSettingsVersion(): number {
  return cacheVersion;
}

// sets the cache straight, no database: a unit test gives no startApp (loadShopSettings) to fill
// it, an integration test may still want one field changed for itself without a real write
// (tests/helpers/shopSettings.ts, the way tests/helpers/delivery.ts does for env). Production code
// never calls this, only writeShopSettings changes the cache for real
export function setShopSettingsForTest(values: Partial<ShopSettingsValues> = {}): void {
  cache = { ...(cache ?? valuesOf(null)), ...values };
}

export function publicShopSettings(): PublicShopSettings {
  const values = shopSettings();
  const out = {} as PublicShopSettings;
  for (const key of PUBLIC_SHOP_SETTINGS_FIELDS) out[key] = values[key] as never;
  return out;
}

// fields with an empty default the shop cannot work with: no mail goes out without a reply-to
// (sendEmail.helper.ts refuses one, EMAIL_REPLY_TO_REQUIRED), so it is named with the fields that
// have no default at all
const REQUIRED_TEXT_FIELDS = [
  'emailReplyTo',
] as const satisfies readonly (keyof ShopSettingsValues & keyof typeof DEFAULTS)[];

// the fields root has not set yet: the ones with no default of the server, and a required text
// still empty or blank (the shop_settings_incomplete alert and GET /api/admin/shop-settings/missing
// read this)
export function missingShopSettingsFields(): (keyof ShopSettingsValues)[] {
  const values = shopSettings();
  const noDefault = NO_DEFAULT_FIELDS.filter((key) => {
    const value = values[key];
    return value === null || (Array.isArray(value) && value.length === 0);
  });
  const blankText = REQUIRED_TEXT_FIELDS.filter((key) => !values[key].trim());
  return [...noDefault, ...blankText];
}

// the default fields kept as a Postgres array (deliveryMethods, enabledLocales): prisma turns a
// null array column into [] when it reads a row, so an empty list root wrote on purpose (no
// delivery method: the shop sends by hand, src/config/deliveryMethods.ts) would look the same as
// one nobody ever wrote. A plain query says which of these the row actually left null
const ARRAY_DEFAULT_FIELDS = [
  'deliveryMethods',
  'enabledLocales',
] as const satisfies readonly (keyof ShopSettingsValues & keyof typeof DEFAULTS)[];

async function nullArrayFieldsOf(
  db: Prisma.TransactionClient,
  id: number | undefined,
): Promise<Set<(typeof ARRAY_DEFAULT_FIELDS)[number]>> {
  if (id === undefined) return new Set(ARRAY_DEFAULT_FIELDS);

  const [row] = await db.$queryRaw<{ deliveryMethods: boolean; enabledLocales: boolean }[]>`
    select "deliveryMethods" is null as "deliveryMethods", "enabledLocales" is null as "enabledLocales"
    from cartlify.shop_settings where id = ${id}
  `;

  return new Set(ARRAY_DEFAULT_FIELDS.filter((key) => row?.[key]));
}

// reads the latest row (admin context: this runs at startup and after a write, never for a
// request of a buyer), fills the cache; a field that has a default and is empty gets a version of
// its own, written as the system (setById null), so the row the app reads next already has it
export async function loadShopSettings(): Promise<void> {
  const { latest, nullArrays } = await tx(async (db) => {
    await setAdminContext(db);
    const latest = await db.shopSetting.findFirst({ orderBy: { version: 'desc' }, select: SELECT });
    const nullArrays = await nullArrayFieldsOf(db, latest?.id);
    return { latest, nullArrays };
  });

  const fillable = (Object.keys(DEFAULTS) as (keyof ShopSettingsValues)[]).filter((key) =>
    (ARRAY_DEFAULT_FIELDS as readonly string[]).includes(key)
      ? nullArrays.has(key as (typeof ARRAY_DEFAULT_FIELDS)[number])
      : latest?.[key] === null || latest?.[key] === undefined,
  );

  if (fillable.length === 0) {
    cache = valuesOf(latest);
    cacheVersion = latest?.version ?? 0;
    return;
  }

  const filled = await tx(async (db) => {
    await setAdminContext(db);
    return db.shopSetting.create({
      data: {
        ...copyForward(latest),
        ...Object.fromEntries(fillable.map((key) => [key, DEFAULTS[key]])),
        // both come from the database (trg_shop_settings_before_insert, db/05)
        version: 0,
        setById: null,
        basedOnVersion: null,
      },
      select: SELECT,
    });
  });

  cache = valuesOf(filled);
  cacheVersion = filled.version;
}

// the fields of a row a new version carries forward unless it overrides them: every field but the
// metadata (id, version) and the ones the caller gives itself
function copyForward(row: Row | null): Record<string, unknown> {
  if (!row) return {};
  const { id: _id, version: _version, ...fields } = row;
  return fields;
}

type WriteArgs = { actorId: UserId; values: WritableShopSettings; baseVersion: number };

// root writes a full version; "baseVersion" is the version root edited from (0 before any row
// exists), the database refuses a stale one (trg_shop_settings_before_insert, SHOP_SETTINGS_OUTDATED).
// The logo is not among the writable fields (its own route writes it), it is copied forward
export async function writeShopSettings(args: WriteArgs): Promise<ShopSettingsValues> {
  const latest = await tx(async (db) => {
    await setAdminContext(db);
    return db.shopSetting.findFirst({
      orderBy: { version: 'desc' },
      select: { logoUrl: true, logoPublicId: true },
    });
  });

  const row = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: 'ROOT' });

    try {
      return await db.shopSetting.create({
        data: {
          ...args.values,
          logoUrl: latest?.logoUrl ?? null,
          logoPublicId: latest?.logoPublicId ?? null,
          // comes from the database too (trg_shop_settings_before_insert, db/05)
          version: 0,
          setById: Number(args.actorId),
          basedOnVersion: args.baseVersion,
        },
        select: SELECT,
      });
    } catch (err) {
      if (getPgMessage(err) === 'SHOP_SETTINGS_OUTDATED') {
        throw new ConflictError('SHOP_SETTINGS_OUTDATED', { baseVersion: args.baseVersion });
      }
      throw err;
    }
  });

  cache = valuesOf(row);
  cacheVersion = row.version;
  return cache;
}

// root writes a new version that only changes the logo, every other field carried forward as it
// was; null, null takes the logo away. The caller already moved the file to its place on
// Cloudinary (or has nothing to move, for a removal); the version root last saw plays no part
// here, a logo is its own action, not an edit of a form that could go stale. A write of root
// between the read and the insert below is rare (one request, two queries apart) but not
// impossible, so a stale basedOnVersion retries once more with the version that beat it
export async function writeShopLogo(args: {
  actorId: UserId;
  logoUrl: string | null;
  logoPublicId: string | null;
}): Promise<{ settings: ShopSettingsValues; oldLogoPublicId: string | null }> {
  const LOGO_WRITE_ATTEMPTS = 3;
  let lastErr: unknown;

  for (let attempt = 0; attempt < LOGO_WRITE_ATTEMPTS; attempt += 1) {
    const latest = await tx(async (db) => {
      await setAdminContext(db);
      return db.shopSetting.findFirst({ orderBy: { version: 'desc' }, select: SELECT });
    });

    try {
      const row = await tx(async (db) => {
        await setUserContext(db, { userId: args.actorId, role: 'ROOT' });

        return db.shopSetting.create({
          data: {
            ...copyForward(latest),
            logoUrl: args.logoUrl,
            logoPublicId: args.logoPublicId,
            // comes from the database too (trg_shop_settings_before_insert, db/05)
            version: 0,
            setById: Number(args.actorId),
            basedOnVersion: latest?.version ?? 0,
          },
          select: SELECT,
        });
      });

      cache = valuesOf(row);
      cacheVersion = row.version;
      return { settings: cache, oldLogoPublicId: latest?.logoPublicId ?? null };
    } catch (err) {
      if (getPgMessage(err) !== 'SHOP_SETTINGS_OUTDATED') throw err;
      lastErr = err;
    }
  }

  throw lastErr;
}

export { isDeliveryMethodName };

import {
  isSupportedDeliveryCountry,
  SUPPORTED_DELIVERY_COUNTRIES,
} from '@config/deliveryCountries.js';
import { AVAILABLE_LOCALES, isAvailableLocale } from '@config/locales.js';
import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  missingShopSettingsFields,
  publicShopSettings,
  shopSettings,
  shopSettingsVersion,
  writeShopSettings,
  type WritableShopSettings,
} from '@config/shopSettings.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { BadRequestError } from '@utils/errors.js';

import type {
  GetShopSettingsHistoryResponseDto,
  PublicShopSettingsDto,
  PutShopSettingsBodyDto,
  ShopSettingsFieldDto,
  ShopSettingsValuesDto,
  ShopSettingsVersionDto,
} from 'types/dto/shopSettings.dto.js';
import type { UserId } from 'types/ids.js';

// the data of the shop (delivery, brand, reservation, moderation, withdrawal, languages, the
// seller): the current version in memory (@config/shopSettings.js), root's writes and history
// (cartlify.shop_settings, docs/shop-settings.md). GET /api/shop-settings is public, the other
// routes are cross-registered into admin.routes.ts and root.routes.ts

export function getPublicShopSettings(): PublicShopSettingsDto {
  return publicShopSettings();
}

export function getShopSettingsValues(): ShopSettingsValuesDto {
  // logoPublicId is internal, it names the file on Cloudinary to replace or remove
  // (setShopLogo.service.ts), no answer sends it out
  const { logoPublicId: _logoPublicId, ...values } = shopSettings();
  return values;
}

const FIELD_KEYS = [
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
] as const satisfies readonly (keyof ShopSettingsValuesDto)[];

export function getShopSettingsField(key: string): ShopSettingsFieldDto {
  const values = shopSettings();
  const found = FIELD_KEYS.find((candidate) => candidate === key);
  // the schema of the route already keeps the key to this list (enum, shopSettingsFieldParamsSchema)
  return { key: found ?? key, value: found ? values[found] : null };
}

export function getShopSettingsMissingFields(): string[] {
  return missingShopSettingsFields();
}

// the shape of a country (two capital letters) is checked in the database (db/06, a CHECK cannot
// hold the full list without duplicating it there); the real list the shop may deliver to is
// checked here, the same list POST /api/orders/confirm checks a buyer's own address against
function assertKnownCountries(countries: readonly string[]): void {
  const unknown = countries.filter((code) => !isSupportedDeliveryCountry(code));
  if (unknown.length) {
    throw new BadRequestError('DELIVERY_COUNTRY_NOT_SUPPORTED', {
      countries: unknown,
      supported: SUPPORTED_DELIVERY_COUNTRIES,
    });
  }
}

// the shape of a locale is checked in the database (db/06); that it has a dictionary
// (src/locales) cannot, the same way a country cannot. shopLocale is already one of
// enabledLocales (assertConsistent), so checking this list alone covers it too
function assertKnownLocales(enabledLocales: readonly string[]): void {
  const unknown = enabledLocales.filter((code) => !isAvailableLocale(code));
  if (unknown.length) {
    throw new BadRequestError('LOCALE_NOT_SUPPORTED', {
      locales: unknown,
      supported: AVAILABLE_LOCALES,
    });
  }
}

// the longest a reservation and the payment page after it may last together: Stripe never keeps
// a page longer than a day (db/06, shop_settings_reservation_chk holds the same)
const MAX_RESERVATION_AND_PAGE_MINUTES = 1440;

// the rules between fields that a schema of one field cannot hold, the ones the env variables
// these fields replace were held to at start; the database keeps them as well (db/06,
// shop_settings_*_chk), but a refusal of its own reaches root as a 500, and a blank text passes it
function assertConsistent(values: Omit<PutShopSettingsBodyDto, 'baseVersion'>): void {
  // a free delivery from some sum is free of a price there must be
  if (values.deliveryFreeFrom !== null && values.deliveryFlatPrice === null) {
    throw new BadRequestError('DELIVERY_FREE_FROM_WITHOUT_PRICE');
  }

  // a buyer who picks the pickup is told where and when to come
  if (values.deliveryMethods.includes('pickup')) {
    const blank = (['pickupAddress', 'pickupHours'] as const).filter((key) => !values[key].trim());
    if (blank.length) throw new BadRequestError('PICKUP_DETAILS_REQUIRED', { fields: blank });
  }

  if (values.reservationMinutes + values.stripePageMinutes > MAX_RESERVATION_AND_PAGE_MINUTES) {
    throw new BadRequestError('RESERVATION_MINUTES_TOO_LONG', {
      max: MAX_RESERVATION_AND_PAGE_MINUTES,
    });
  }

  // a buyer with no language of their own gets the shop's, it must be one the shop answers in
  if (!values.enabledLocales.includes(values.shopLocale)) {
    throw new BadRequestError('SHOP_LOCALE_NOT_ENABLED', {
      shopLocale: values.shopLocale,
      enabledLocales: values.enabledLocales,
    });
  }
}

export async function putShopSettings(args: {
  actorId: UserId;
  body: PutShopSettingsBodyDto;
}): Promise<ShopSettingsValuesDto> {
  const { baseVersion, ...values } = args.body;
  assertConsistent(values);
  assertKnownCountries(values.deliveryCountries);
  assertKnownLocales(values.enabledLocales);
  const written = await writeShopSettings({
    actorId: args.actorId,
    baseVersion,
    values: values as WritableShopSettings,
  });
  const { logoPublicId: _logoPublicId, ...result } = written;
  return result;
}

export function getShopSettingsCurrentVersion(): number {
  return shopSettingsVersion();
}

export async function getShopSettingsHistory(args: {
  actorId: UserId;
  actorRole: 'ROOT';
  limit: number;
  cursor?: string | undefined;
}): Promise<GetShopSettingsHistoryResponseDto> {
  const after = args.cursor ? decodeCursor(args.cursor).id : undefined;

  const rows = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    return db.shopSetting.findMany({
      ...(after !== undefined ? { where: { id: { lt: after } } } : {}),
      orderBy: { id: 'desc' },
      take: args.limit + 1,
      include: { setBy: { select: { id: true, name: true, email: true, deletedAt: true } } },
    });
  });

  const page = rows.slice(0, args.limit);
  const last = page[page.length - 1];

  const items: ShopSettingsVersionDto[] = page.map((row) => ({
    version: row.version,
    setBy: row.setBy
      ? {
          id: row.setBy.id,
          name: row.setBy.name,
          // a deleted account keeps what it set, not its address
          email: row.setBy.deletedAt ? null : row.setBy.email,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    deliveryMethods: row.deliveryMethods as ShopSettingsVersionDto['deliveryMethods'],
    deliveryFlatPrice: row.deliveryFlatPrice != null ? Number(row.deliveryFlatPrice) : null,
    deliveryFreeFrom: row.deliveryFreeFrom != null ? Number(row.deliveryFreeFrom) : null,
    deliveryCountries: row.deliveryCountries,
    pickupAddress: row.pickupAddress ?? '',
    pickupHours: row.pickupHours ?? '',
    shopName: row.shopName ?? '',
    emailFromName: row.emailFromName ?? '',
    emailReplyTo: row.emailReplyTo ?? '',
    logoUrl: row.logoUrl,
    reservationMinutes: row.reservationMinutes ?? 0,
    stripePageMinutes: row.stripePageMinutes ?? 0,
    reviewCheckEnabled: row.reviewCheckEnabled ?? false,
    avatarRemovalsLimit: row.avatarRemovalsLimit ?? 0,
    reviewRemovalsLimit: row.reviewRemovalsLimit ?? 0,
    withdrawalGraceDays: row.withdrawalGraceDays ?? 0,
    shopLocale: row.shopLocale ?? '',
    enabledLocales: row.enabledLocales,
    sellerLegalName: row.sellerLegalName,
    sellerAddress: row.sellerAddress,
    sellerTaxId: row.sellerTaxId,
    sellerEmail: row.sellerEmail,
    sellerPhone: row.sellerPhone,
  }));

  return {
    items,
    nextCursor: rows.length > args.limit && last ? encodeCursor({ id: last.id, v: null }) : null,
  };
}

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
  writeShopSettings,
  type ShopSettingsValues,
  type WritableShopSettingKey,
  type WritableShopSettings,
} from '@config/shopSettings.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { isPickupHours } from '@helpers/pickupHours.js';
import { BadRequestError } from '@utils/errors.js';

import type {
  GetShopSettingsHistoryResponseDto,
  PublicShopSettingsDto,
  PutShopSettingsBodyDto,
  ShopSettingsHistoryItemDto,
  ShopSettingsValuesDto,
} from 'types/dto/shopSettings.dto.js';
import type { UserId } from 'types/ids.js';

// the data of the shop (delivery, brand, reservation, moderation, withdrawal, languages, the
// seller, the logo): the current values in memory (@config/shopSettings.js), root's writes and
// the history of the rows (cartlify.shop_settings, docs/shop-settings.md). GET /api/shop-settings
// is public, the other routes are cross-registered into admin.routes.ts and root.routes.ts

// logoPublicId is internal, it names the file on Cloudinary to replace or remove
// (setShopLogo.service.ts), no answer sends it out
export const valuesDtoOf = ({ logoPublicId: _logoPublicId, ...values }: ShopSettingsValues) =>
  values satisfies ShopSettingsValuesDto;

export function getPublicShopSettings(): PublicShopSettingsDto {
  return publicShopSettings();
}

export function getShopSettingsValues(): ShopSettingsValuesDto {
  return valuesDtoOf(shopSettings());
}

export function getShopSettingsMissingFields(): string[] {
  return missingShopSettingsFields();
}

// the longest a reservation and the payment page after it may last together: Stripe never keeps
// a page longer than a day
const MAX_RESERVATION_AND_PAGE_MINUTES = 1440;

// the rules between settings, and the lists the app keeps, checked on the values a write would
// leave (the ones given over the current ones): the database checks the shape of each value by
// its key, but a row cannot see the rows of the other keys, and the countries a postal code is
// known of and the languages with a dictionary are lists of the app (db/05, shop_setting_value_valid)
function checkSettings(values: ShopSettingsValues): void {
  // a free delivery from some sum is free of a price there must be
  if (values.deliveryFreeFrom !== null && values.deliveryFlatPrice === null) {
    throw new BadRequestError('DELIVERY_FREE_FROM_WITHOUT_PRICE');
  }

  // a buyer who picks the pickup is told where and when to come
  if (values.deliveryMethods.includes('pickup')) {
    const blank = (['pickupAddress', 'pickupHours'] as const).filter((key) => !values[key].trim());
    if (blank.length) throw new BadRequestError('PICKUP_DETAILS_REQUIRED', { fields: blank });
  }

  // the hours are written in the one format the frontend parses and a mail translates
  // (src/helpers/pickupHours.ts), whether the pickup is on or not; empty is no hours
  if (values.pickupHours && !isPickupHours(values.pickupHours)) {
    throw new BadRequestError('PICKUP_HOURS_INVALID');
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

  // the countries the app knows how to take a postal code of, the same list POST
  // /api/orders/confirm checks a buyer's own address against
  const unknownCountries = values.deliveryCountries.filter(
    (code) => !isSupportedDeliveryCountry(code),
  );
  if (unknownCountries.length) {
    throw new BadRequestError('DELIVERY_COUNTRY_NOT_SUPPORTED', {
      countries: unknownCountries,
      supported: SUPPORTED_DELIVERY_COUNTRIES,
    });
  }

  // a language needs a dictionary (src/locales); shopLocale is one of these already (above)
  const unknownLocales = values.enabledLocales.filter((code) => !isAvailableLocale(code));
  if (unknownLocales.length) {
    throw new BadRequestError('LOCALE_NOT_SUPPORTED', {
      locales: unknownLocales,
      supported: AVAILABLE_LOCALES,
    });
  }
}

// every setting at once: a row for each whose value changes
export async function putShopSettings(args: {
  actorId: UserId;
  body: PutShopSettingsBodyDto;
}): Promise<ShopSettingsValuesDto> {
  const written = await writeShopSettings({
    actorId: args.actorId,
    values: args.body as WritableShopSettings,
    check: checkSettings,
  });
  return valuesDtoOf(written);
}

// one setting: a row for it, none when it already has the value. The shape of the value is
// checked by the controller (the schema of the setting), the rules between settings here, on the
// values with this one changed
export async function putShopSetting(args: {
  actorId: UserId;
  key: WritableShopSettingKey;
  value: unknown;
}): Promise<ShopSettingsValuesDto> {
  const written = await writeShopSettings({
    actorId: args.actorId,
    values: { [args.key]: args.value } as Partial<WritableShopSettings>,
    check: checkSettings,
  });
  return valuesDtoOf(written);
}

// the rows of every setting, or of one, the latest first; logoPublicId is internal (see
// valuesDtoOf), its rows are not shown
export async function getShopSettingsHistory(args: {
  actorId: UserId;
  actorRole: 'ROOT';
  limit: number;
  cursor?: string | undefined;
  key?: string | undefined;
}): Promise<GetShopSettingsHistoryResponseDto> {
  const after = args.cursor ? decodeCursor(args.cursor).id : undefined;

  const rows = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    return db.shopSetting.findMany({
      where: {
        ...(args.key !== undefined ? { key: args.key } : { key: { not: 'logoPublicId' } }),
        ...(after !== undefined ? { id: { lt: after } } : {}),
      },
      orderBy: { id: 'desc' },
      take: args.limit + 1,
      include: { setBy: { select: { id: true, name: true, email: true, deletedAt: true } } },
    });
  });

  const page = rows.slice(0, args.limit);
  const last = page[page.length - 1];

  const items: ShopSettingsHistoryItemDto[] = page.map((row) => ({
    key: row.key,
    value: row.value,
    setBy: row.setBy
      ? {
          id: row.setBy.id,
          name: row.setBy.name,
          // a deleted account keeps what it set, not its address
          email: row.setBy.deletedAt ? null : row.setBy.email,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  }));

  return {
    items,
    nextCursor: rows.length > args.limit && last ? encodeCursor({ id: last.id, v: null }) : null,
  };
}

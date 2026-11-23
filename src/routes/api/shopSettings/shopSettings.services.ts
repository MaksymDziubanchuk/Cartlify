import {
  isSupportedDeliveryCountry,
  SUPPORTED_DELIVERY_COUNTRIES,
} from '@config/deliveryCountries.js';
import { AVAILABLE_LOCALES, isAvailableLocale } from '@config/locales.js';
import { tx } from '@db/client.js';
import { settingsRefusalOf } from '@helpers/settingsRefusal.js';
import { setUserContext } from '@db/dbContext.service.js';
import { rateOf, type ShopCountriesState } from '@config/shopCountries.js';
import {
  missingShopSettingsFields,
  publicShopSettings,
  shopSettings,
  UNSUPPORTED_SELLER_COUNTRIES,
  writeShopSettings,
  type ShopSettingsValues,
  type WritableShopSettingKey,
  type WritableShopSettings,
} from '@config/shopSettings.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { isPickupHours } from '@helpers/pickupHours.js';
import { checkReceiptSettings } from '@helpers/receiptSettings.js';
import { deliveryProvider } from '@providers/delivery/index.js';
import { paymentPageBounds } from '@providers/payments/index.js';
import { receiptProvider } from '@providers/receipts/index.js';
import { BadRequestError } from '@utils/errors.js';

import type {
  GetShopLocaleCountsResponseDto,
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

// logoPublicId is internal, it names the file in the file storage to replace or remove
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
  return missingShopSettingsFields({ receipts: receiptProvider.makesReceipts() });
}

// the rules between settings, and the lists the app keeps, checked on the values a write would
// leave (the ones given over the current ones) and the countries the shop sells to as the write
// leaves them: the database checks the shape of each value by its key, but a row cannot see the
// rows of the other keys, and the countries a postal code is known of and the languages with a
// dictionary are lists of the app (db/05, shop_setting_value_valid). The route of a country runs
// the same check (countries.services.ts)
export function checkSettings(values: ShopSettingsValues, countries: ShopCountriesState): void {
  // a carrier of the delivery provider needs the address the parcels go from, and the provider
  // to be turned on (a key taken away later does not stop root changing the other settings)
  if (values.deliveryMethods.includes('carrier')) {
    const turnedOn = !shopSettings().deliveryMethods.includes('carrier');
    if (turnedOn && !deliveryProvider.isConfigured()) {
      throw new BadRequestError('DELIVERY_PROVIDER_NOT_CONFIGURED');
    }
    if (!values.deliverySender) throw new BadRequestError('DELIVERY_SENDER_REQUIRED');
  }

  // a country in one zone only, a name once (the database holds the same, the refusal here says
  // which)
  const zoneCountries = values.deliveryZones.flatMap((zone) => zone.countries);
  const repeated = [...new Set(zoneCountries.filter((c, i) => zoneCountries.indexOf(c) !== i))];
  if (repeated.length) {
    throw new BadRequestError('DELIVERY_ZONE_COUNTRY_REPEATED', { countries: repeated });
  }
  const names = values.deliveryZones.map((zone) => zone.name);
  const sameNames = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (sameNames.length) {
    throw new BadRequestError('DELIVERY_ZONE_NAME_REPEATED', { names: sameNames });
  }

  // a buyer who picks the pickup is told where and when to come; the place is in a country the shop
  // has a record of, which taxes the pickup
  if (values.deliveryMethods.includes('pickup')) {
    const blank: string[] = (['pickupAddress', 'pickupHours'] as const).filter(
      (key) => !values[key].trim(),
    );
    if (!values.pickupCountry) blank.push('pickupCountry');
    if (blank.length) throw new BadRequestError('PICKUP_DETAILS_REQUIRED', { fields: blank });
  }

  // the hours are written in the one format the frontend parses and a mail translates
  // (src/helpers/pickupHours.ts), whether the pickup is on or not; empty is no hours
  if (values.pickupHours && !isPickupHours(values.pickupHours)) {
    throw new BadRequestError('PICKUP_HOURS_INVALID');
  }

  // the reservation and the payment page after it together, as long as every payment provider
  // keeps a page at most
  const { mostWithReservation } = paymentPageBounds();
  if (values.reservationMinutes + values.paymentPageMinutes > mostWithReservation) {
    throw new BadRequestError('RESERVATION_MINUTES_TOO_LONG', { max: mostWithReservation });
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
  const unknownCountries = [...new Set(zoneCountries)].filter(
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

  // every country the shop delivers to, and the one of the pickup, has its record (customs, the tax)
  const recordless = [
    ...new Set([
      ...zoneCountries,
      ...(values.deliveryMethods.includes('pickup') && values.pickupCountry
        ? [values.pickupCountry]
        : []),
    ]),
  ].filter((code) => !countries.countries.has(code));
  if (recordless.length) {
    throw new BadRequestError('SHOP_COUNTRY_MISSING', { countries: recordless });
  }

  checkTaxSettings(values, countries);
}

// the settings of the tax and of the documents (docs/taxes.md): a country of a seller the app
// serves; a shop that takes the tax in its own country names its country with the rates there, its
// tax id with the words before it, and a rule for every country without customs; the invoices with
// both series, apart from each other, and whether one starts every year
function checkTaxSettings(values: ShopSettingsValues, countries: ShopCountriesState): void {
  const seller = values.sellerCountry;
  if (seller && (UNSUPPORTED_SELLER_COUNTRIES as readonly string[]).includes(seller)) {
    throw new BadRequestError('SELLER_COUNTRY_NOT_SUPPORTED', {
      country: seller,
      unsupported: UNSUPPORTED_SELLER_COUNTRIES,
    });
  }

  if (values.vatPayer === true) {
    const missing = (['sellerCountry', 'sellerTaxId', 'sellerTaxIdLabel'] as const).filter(
      (key) => !values[key],
    );
    if (missing.length) throw new BadRequestError('SELLER_TAX_DATA_REQUIRED', { fields: missing });

    const record = countries.countries.get(seller!);
    if (!record || rateOf(record, null, new Date()) === null) {
      throw new BadRequestError('SELLER_COUNTRY_RATES_REQUIRED', { country: seller });
    }

    const ruleless = [...countries.countries.values()]
      .filter((c) => c.customsFree && c.rule === null)
      .map((c) => c.country);
    if (ruleless.length) {
      throw new BadRequestError('SHOP_COUNTRY_RULE_REQUIRED', { countries: ruleless });
    }
  }

  if (values.invoiceMode !== null) {
    const missing = (['invoicePrefix', 'creditNotePrefix', 'invoiceYearly'] as const).filter(
      (key) => values[key] === null,
    );
    if (missing.length) throw new BadRequestError('INVOICE_SERIES_REQUIRED', { fields: missing });
    if (values.invoicePrefix === values.creditNotePrefix) {
      throw new BadRequestError('INVOICE_SERIES_SAME');
    }
  }

  checkReceiptSettings(values, receiptProvider, shopSettings().receiptMoment);
}

// a write with the refusals of the database (the guard of the series of the documents, db/05:
// trg_shop_settings_series_taken) as a 400 with their code
async function writtenOrRefused(write: Promise<ShopSettingsValues>): Promise<ShopSettingsValues> {
  try {
    return await write;
  } catch (err) {
    throw settingsRefusalOf(err);
  }
}

// every setting at once: a row for each whose value changes
export async function putShopSettings(args: {
  actorId: UserId;
  body: PutShopSettingsBodyDto;
}): Promise<ShopSettingsValuesDto> {
  const written = await writtenOrRefused(
    writeShopSettings({
      actorId: args.actorId,
      values: args.body as WritableShopSettings,
      check: checkSettings,
    }),
  );
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
  const written = await writtenOrRefused(
    writeShopSettings({
      actorId: args.actorId,
      values: { [args.key]: args.value } as Partial<WritableShopSettings>,
      check: checkSettings,
    }),
  );
  return valuesDtoOf(written);
}

// How many accounts and how many subscriptions of the newsletters have each language (the function
// of the database counts them for root alone): the warning root is shown before a language is
// turned off, since the people who have it are left with none and are mailed in the language of the
// shop (writeShopSettings, @config/shopSettings.js)
export async function getShopLocaleCounts(args: {
  actorId: UserId;
  actorRole: 'ROOT';
}): Promise<GetShopLocaleCountsResponseDto> {
  const rows = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: args.actorRole });
    return db.$queryRaw<
      { locale: string; accounts: number; subscriptions: number }[]
    >`select locale, accounts, subscriptions from cartlify.newsletter_locale_counts()`;
  });

  return {
    items: rows.map((row) => ({
      locale: row.locale,
      accounts: Number(row.accounts),
      subscriptions: Number(row.subscriptions),
    })),
  };
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

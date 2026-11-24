import { Prisma } from '@prisma/client';

import type { DeliveryZone } from '@config/deliveryZones.js';
import {
  loadShopCountries,
  shopCountries,
  shopCountry,
  thresholdCycleOf,
  thresholdHeldOf,
  type ShopCountry,
} from '@config/shopCountries.js';
import { shopSettings, writeShopSettings } from '@config/shopSettings.js';
import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { settingsRefusalOf } from '@helpers/settingsRefusal.js';
import { BadRequestError, NotFoundError } from '@utils/errors.js';

import { checkSettings } from '../../shopSettings/shopSettings.services.js';

import type {
  GetShopCountriesResponseDto,
  PostCopyExceptionsResponseDto,
  PutShopCountryBodyDto,
  ShopCountryDto,
  ShopCountryZoneDto,
} from 'types/dto/taxes.dto.js';
import type { UserId } from 'types/ids.js';

// The countries the shop sells to (docs/taxes.md): root writes a country and its zone of the
// delivery in one transaction, under the lock of the data of the shop (writeShopSettings), so the
// zones and the records never part; the check of the settings runs on both as the write leaves them.
// What a record may hold is the database's (db/05, shop_countries_before_write); its refusals come
// back as a 400 with their code.

const zoneOfCountry = (zones: readonly DeliveryZone[], country: string): DeliveryZone | null =>
  zones.find((zone) => zone.countries.includes(country)) ?? null;

function countryDtoOf(
  record: ShopCountry,
  zones: readonly DeliveryZone[],
  at: Date = new Date(),
): ShopCountryDto {
  const zone = zoneOfCountry(zones, record.country);
  const threshold = record.threshold;

  return {
    country: record.country,
    zone: zone ? { name: zone.name, manualPrice: zone.manualPrice, freeFrom: zone.freeFrom } : null,
    customsFree: record.customsFree,
    rule: record.rule,
    registered: record.registered,
    taxNumber: record.taxNumber,
    taxNumberLabel: record.taxNumberLabel,
    taxNumberKind: record.taxNumberKind,
    parcelLimit: record.parcelLimit,
    threshold: threshold
      ? {
          amount: threshold.amount,
          withVat: threshold.withVat,
          group: threshold.group,
          period: threshold.period,
          startMonth: threshold.startMonth,
          nextCycle: nextCycleOf(threshold, at),
          cycleFrom: thresholdCycleOf(threshold, at).from.toISOString(),
          nextCycleFrom: thresholdCycleOf(threshold, at).nextFrom?.toISOString() ?? null,
          held: threshold.period === 'rolling_12' && thresholdHeldOf(threshold, { from: at }, null),
        }
      : null,
    deliveryVat: record.deliveryVat,
    exportPrice: record.exportPrice,
    exemptionText: record.exemptionText,
    rates: record.rates,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

// a read of root takes the records fresh: the hold of a threshold of the last 12 months is written
// by the database at a confirmation (hold_tax_threshold), on whichever server took it, not by root
export async function getShopCountries(): Promise<GetShopCountriesResponseDto> {
  await loadShopCountries();
  const zones = shopSettings().deliveryZones;
  return { items: [...shopCountries().values()].map((record) => countryDtoOf(record, zones)) };
}

export async function getShopCountry(country: string): Promise<ShopCountryDto> {
  await loadShopCountries();
  const record = shopCountry(country);
  if (!record) throw new NotFoundError('SHOP_COUNTRY_NOT_FOUND');
  return countryDtoOf(record, shopSettings().deliveryZones);
}

// the zones after a country goes into a zone with its prices (a new name makes a zone), or out of
// every zone; a zone left without a country goes
function zonesWith(
  zones: readonly DeliveryZone[],
  country: string,
  zone: ShopCountryZoneDto | null,
): DeliveryZone[] {
  const without = zones.map((z) => ({ ...z, countries: z.countries.filter((c) => c !== country) }));

  if (zone) {
    const own = without.find((z) => z.name === zone.name);
    if (own) {
      own.countries.push(country);
      own.manualPrice = zone.manualPrice;
      own.freeFrom = zone.freeFrom;
    } else {
      without.push({ ...zone, countries: [country] });
    }
  }

  return without.filter((z) => z.countries.length > 0);
}

// the rule the next cycle of a threshold starts with: a year root started from the first rule at
// its next start (a cycle of the last 12 months goes back at once: none waits)
function nextCycleOf(
  threshold: NonNullable<ShopCountry['threshold']>,
  at: Date,
): 'recipient' | 'initial' {
  const next = thresholdCycleOf(threshold, at).nextFrom;
  return next && threshold.initialFrom?.getTime() === next.getTime() ? 'initial' : 'recipient';
}

// the moment the first rule holds from by the choice of root: the start of the next year, or now
// for the last 12 months; recipient keeps what a cycle of the last 12 months had and clears it for
// a year
function initialFromOf(
  body: PutShopCountryBodyDto,
  kept: ShopCountry['threshold'] | undefined,
  at: Date,
): Date | null {
  const threshold = body.threshold;
  if (!threshold) return null;
  const cycle = thresholdCycleOf(
    { period: threshold.period, startMonth: threshold.startMonth ?? null },
    at,
  );
  if (threshold.period === 'rolling_12') {
    return threshold.nextCycle === 'initial' ? at : (kept?.initialFrom ?? null);
  }
  return threshold.nextCycle === 'initial' ? cycle.nextFrom : null;
}

// the columns of a record from what root wrote
function recordData(body: PutShopCountryBodyDto, initialFrom: Date | null) {
  return {
    customsFree: body.customsFree,
    rule: body.rule,
    registered: body.registered,
    taxNumber: body.taxNumber,
    taxNumberLabel: body.taxNumberLabel,
    taxNumberKind: body.taxNumberKind,
    parcelLimit: body.parcelLimit?.amount ?? null,
    parcelLimitWithDelivery: body.parcelLimit?.withDelivery ?? null,
    parcelLimitWithVat: body.parcelLimit?.withVat ?? null,
    thresholdAmount: body.threshold?.amount ?? null,
    thresholdWithVat: body.threshold?.withVat ?? null,
    thresholdGroup: body.threshold?.group ?? null,
    thresholdPeriod: body.threshold?.period ?? null,
    thresholdStartMonth:
      body.threshold?.period === 'year' ? (body.threshold.startMonth ?? 1) : null,
    thresholdInitialFrom: initialFrom,
    deliveryVat: body.deliveryVat,
    exportPrice: body.exportPrice,
    exemptionText: body.exemptionText,
    rates: body.rates as unknown as Prisma.InputJsonValue,
  };
}

// root writes a country: its record and its zone, at once. The threshold of a group is one for all
// its countries: the others of the group take the sum, the measure and the end written here first,
// so the new one joins them with the period they have
export async function putShopCountry(args: {
  actorId: UserId;
  country: string;
  body: PutShopCountryBodyDto;
}): Promise<ShopCountryDto> {
  const { country, body } = args;

  try {
    await writeShopSettings({
      actorId: args.actorId,
      values: (previous) => ({
        deliveryZones: zonesWith(previous.deliveryZones, country, body.zone),
      }),
      countries: async (db) => {
        const data = recordData(
          body,
          initialFromOf(body, shopCountry(country)?.threshold, new Date()),
        );
        if (body.threshold?.group) {
          await db.shopCountry.updateMany({
            where: { thresholdGroup: body.threshold.group, country: { not: country } },
            data: {
              thresholdAmount: data.thresholdAmount,
              thresholdWithVat: data.thresholdWithVat,
              thresholdPeriod: data.thresholdPeriod,
              thresholdStartMonth: data.thresholdStartMonth,
              thresholdInitialFrom: data.thresholdInitialFrom,
            },
          });
        }
        await db.shopCountry.upsert({
          where: { country },
          create: { country, ...data },
          update: data,
        });
      },
      check: checkSettings,
    });
  } catch (err) {
    throw settingsRefusalOf(err);
  }

  return getShopCountry(country);
}

// root takes a country away with its place in its zone; a country the settings need (the one of the
// seller that takes the tax, the one of the pickup) stays (the check of the settings refuses)
export async function deleteShopCountry(args: { actorId: UserId; country: string }): Promise<void> {
  try {
    await writeShopSettings({
      actorId: args.actorId,
      values: (previous) => ({
        deliveryZones: zonesWith(previous.deliveryZones, args.country, null),
      }),
      countries: async (db) => {
        const removed = await db.shopCountry.deleteMany({ where: { country: args.country } });
        if (removed.count === 0) throw new NotFoundError('SHOP_COUNTRY_NOT_FOUND');
      },
      check: checkSettings,
    });
  } catch (err) {
    throw settingsRefusalOf(err);
  }
}

// the classes of the products for one country copied to another (Б1): every product the first
// country classes in a group gets the same class for the second, over what it had for it
export async function copyShopCountryExceptions(args: {
  actorId: UserId;
  country: string;
  from: string;
}): Promise<PostCopyExceptionsResponseDto> {
  if (args.from === args.country) throw new BadRequestError('SHOP_COUNTRY_COPY_SAME');

  const products = await tx(async (db) => {
    await setUserContext(db, { userId: args.actorId, role: 'ROOT' });
    const record = await db.shopCountry.findUnique({ where: { country: args.country } });
    if (!record) throw new NotFoundError('SHOP_COUNTRY_NOT_FOUND');
    return db.$executeRaw`
      update cartlify.products
      set "taxExceptions" = "taxExceptions" || jsonb_build_object(${args.country}::text, "taxExceptions" -> ${args.from}::text)
      where "taxExceptions" ? ${args.from}::text
    `;
  });

  return { products };
}

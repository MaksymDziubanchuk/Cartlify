import { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { parseShopTime } from '@helpers/shopTime.js';

// The countries the shop sells to, its own included, with the rule of their tax
// (cartlify.shop_countries), and the tax groups of the products (cartlify.tax_groups): kept in
// memory like the data of the shop, read at the start of the server and again after every write of
// root (loadShopCountries). The delivery (which countries it goes to, customs) and the tax provider
// read them from here (docs/taxes.md). The database checks what each rule needs (db/05,
// shop_countries_before_write); the code only reads.

export const TAX_RULES = ['seller', 'recipient', 'none', 'buyer_at_receipt'] as const;
export type TaxRuleName = (typeof TAX_RULES)[number];

export const TAX_NUMBER_KINDS = ['ioss', 'other'] as const;
export type TaxNumberKindName = (typeof TAX_NUMBER_KINDS)[number];

export const THRESHOLD_PERIODS = ['year', 'rolling_12'] as const;
export type ThresholdPeriodName = (typeof THRESHOLD_PERIODS)[number];

export const DELIVERY_VAT_RULES = ['main', 'proportional'] as const;
export type DeliveryVatName = (typeof DELIVERY_VAT_RULES)[number];

export const EXPORT_PRICE_RULES = ['same', 'without_seller_vat'] as const;
export type ExportPriceName = (typeof EXPORT_PRICE_RULES)[number];

// a rate of a country: of a group (null: the main rate), in force from a time (null: from the start)
export type TaxRateEntry = { group: number | null; rate: number; from: string | null };

export type ShopCountry = {
  country: string;
  // the parcel does not cross a customs border
  customsFree: boolean;
  // null: a country without customs of a shop that takes no tax in its own country
  rule: TaxRuleName | null;
  // the rule recipient: registered there, with the number, its label and its kind
  registered: boolean;
  taxNumber: string | null;
  taxNumberLabel: string | null;
  taxNumberKind: TaxNumberKindName | null;
  // the rule recipient holds up to this price of a parcel
  parcelLimit: { amount: number; withDelivery: boolean; withVat: boolean } | null;
  // the rule recipient holds once the sales of the period pass this sum; countries of one group
  // share it. The period: a year from the 1st of a month, or the last 12 months (thresholdCycleOf).
  // initialFrom: root chose the first rule from then (the start of a year, or the moment of the
  // last 12 months); heldAt: the moment the sales of the last 12 months passed it (the database)
  threshold: {
    amount: number;
    withVat: boolean;
    group: string | null;
    period: ThresholdPeriodName;
    startMonth: number | null;
    initialFrom: Date | null;
    heldAt: Date | null;
  } | null;
  deliveryVat: DeliveryVatName | null;
  exportPrice: ExportPriceName | null;
  exemptionText: string | null;
  rates: TaxRateEntry[];
  createdAt: Date;
  updatedAt: Date;
};

export type TaxGroup = { id: number; name: string };

// the countries and the groups as a write left them
export type ShopCountriesState = { countries: Map<string, ShopCountry>; groups: TaxGroup[] };

type Cache = ShopCountriesState;

let cache: Cache | null = null;

type CountryRow = {
  country: string;
  customsFree: boolean;
  rule: TaxRuleName | null;
  registered: boolean;
  taxNumber: string | null;
  taxNumberLabel: string | null;
  taxNumberKind: TaxNumberKindName | null;
  parcelLimit: Prisma.Decimal | null;
  parcelLimitWithDelivery: boolean | null;
  parcelLimitWithVat: boolean | null;
  thresholdAmount: Prisma.Decimal | null;
  thresholdWithVat: boolean | null;
  thresholdGroup: string | null;
  thresholdPeriod: ThresholdPeriodName | null;
  thresholdStartMonth: number | null;
  thresholdInitialFrom: Date | null;
  thresholdHeldAt: Date | null;
  deliveryVat: DeliveryVatName | null;
  exportPrice: ExportPriceName | null;
  exemptionText: string | null;
  rates: unknown;
  createdAt: Date;
  updatedAt: Date;
};

// a row of the table as the code reads it
function countryOfRow(row: CountryRow): ShopCountry {
  return {
    country: row.country,
    customsFree: row.customsFree,
    rule: row.rule,
    registered: row.registered,
    taxNumber: row.taxNumber,
    taxNumberLabel: row.taxNumberLabel,
    taxNumberKind: row.taxNumberKind,
    parcelLimit:
      row.parcelLimit === null
        ? null
        : {
            amount: Number(row.parcelLimit),
            withDelivery: row.parcelLimitWithDelivery === true,
            withVat: row.parcelLimitWithVat === true,
          },
    threshold:
      row.thresholdAmount === null
        ? null
        : {
            amount: Number(row.thresholdAmount),
            withVat: row.thresholdWithVat === true,
            group: row.thresholdGroup,
            period: row.thresholdPeriod ?? 'year',
            startMonth: row.thresholdStartMonth,
            initialFrom: row.thresholdInitialFrom,
            heldAt: row.thresholdHeldAt,
          },
    deliveryVat: row.deliveryVat,
    exportPrice: row.exportPrice,
    exemptionText: row.exemptionText,
    rates: (Array.isArray(row.rates) ? row.rates : []) as TaxRateEntry[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// every country and group, in the transaction given (any context reads them, db/03)
export async function readShopCountries(db: Prisma.TransactionClient): Promise<Cache> {
  const rows = await db.shopCountry.findMany({ orderBy: { country: 'asc' } });
  const groups = await db.taxGroup.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });

  return {
    countries: new Map(rows.map((row) => [row.country, countryOfRow(row as CountryRow)])),
    groups,
  };
}

function current(): Cache {
  if (!cache) throw new Error('shop countries were not loaded (loadShopCountries)');
  return cache;
}

// the countries the shop sells to, by their code
export function shopCountries(): ReadonlyMap<string, ShopCountry> {
  return current().countries;
}

// the record of a country, null when the shop does not sell there
export function shopCountry(country: string | null | undefined): ShopCountry | null {
  if (!country) return null;
  return current().countries.get(country) ?? null;
}

export function taxGroups(): readonly TaxGroup[] {
  return current().groups;
}

// reads every country and group under the system context and fills the cache (at the start of the
// server, src/index.ts and tests/helpers/app.ts, and after every write of root)
export async function loadShopCountries(): Promise<void> {
  cache = await tx(async (db) => {
    await setAdminContext(db);
    return readShopCountries(db);
  });
}

// sets the cache straight after a write that already read the rows in its own transaction
export function setShopCountries(next: Cache): void {
  cache = next;
}

// sets the cache straight, no database: an integration test gives the countries of its own file
// without writing the shared table (tests/helpers/shopCountries.ts). Production code never calls it
export function setShopCountriesForTest(
  countries: readonly ShopCountry[] = [],
  groups: readonly TaxGroup[] = cache?.groups ?? [],
): void {
  cache = { countries: new Map(countries.map((c) => [c.country, c])), groups: [...groups] };
}

// the cycle of a threshold at a moment: a year from the 1st of its month at midnight in the time
// zone of the shop (from, the one before it, the next one), or the last 12 months (from only)
export function thresholdCycleOf(
  threshold: Pick<NonNullable<ShopCountry['threshold']>, 'period' | 'startMonth'>,
  at: Date,
  timeZone: string = env.SHOP_TIME_ZONE,
): { from: Date; previousFrom: Date | null; nextFrom: Date | null } {
  if (threshold.period === 'rolling_12') {
    const from = new Date(at);
    from.setUTCMonth(from.getUTCMonth() - 12);
    return { from, previousFrom: null, nextFrom: null };
  }

  const month = threshold.startMonth ?? 1;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const now = Number(parts.find((p) => p.type === 'month')?.value);
  const start = now >= month ? year : year - 1;
  const midnight = (y: number) => {
    const moment = parseShopTime(`${y}-${String(month).padStart(2, '0')}-01T00:00`, timeZone);
    if (!moment) throw new Error('the cycle of a threshold has no start');
    return moment;
  };
  return {
    from: midnight(start),
    previousFrom: midnight(start - 1),
    nextFrom: midnight(start + 1),
  };
}

// whether a threshold holds the tax of the recipient whatever the sales of its cycle now: the cycle
// before passed it and root did not start this one with the first rule (a year), or the sales passed
// it since root last went back to the first rule (the last 12 months)
export function thresholdHeldOf(
  threshold: NonNullable<ShopCountry['threshold']>,
  cycle: { from: Date },
  previousSales: number | null,
): boolean {
  if (threshold.period === 'rolling_12') {
    return (
      threshold.heldAt !== null &&
      (threshold.initialFrom === null ||
        threshold.heldAt.getTime() > threshold.initialFrom.getTime())
    );
  }
  return (
    previousSales !== null &&
    Math.round(previousSales * 100) > Math.round(threshold.amount * 100) &&
    threshold.initialFrom?.getTime() !== cycle.from.getTime()
  );
}

// the rate of a group of a country at a moment: the entry of the group with the latest start that
// has come; null when the country has none for it (no rates, or a group it does not name)
export function rateOf(country: ShopCountry, group: number | null, at: Date): number | null {
  let best: TaxRateEntry | null = null;
  for (const entry of country.rates) {
    if (entry.group !== group) continue;
    const from = entry.from === null ? -Infinity : new Date(entry.from).getTime();
    if (from > at.getTime()) continue;
    const bestFrom =
      best === null || best.from === null ? -Infinity : new Date(best.from).getTime();
    if (best === null || from > bestFrom) best = entry;
  }
  return best ? best.rate : null;
}

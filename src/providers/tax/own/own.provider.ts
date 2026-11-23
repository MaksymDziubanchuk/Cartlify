import type { Prisma } from '@prisma/client';

import {
  shopCountries,
  shopCountry,
  thresholdCycleOf,
  thresholdHeldOf,
  type ShopCountry,
} from '@config/shopCountries.js';
import { shopSettings } from '@config/shopSettings.js';

import type { TaxProvider, TaxQuote } from '../types.js';

import { quoteOwnTax } from './ownTax.js';

// Our own logic of the tax, no outside service: the rules, the rates and the conditions root wrote
// for the countries (cartlify.shop_countries through @config/shopCountries.js), the sales of the
// period of a threshold from the money journal (cartlify.tax_threshold_sales, db/05). The
// arithmetic is in ownTax.ts.

// the sales of a span of a threshold to its countries [from, to), to null for until now, with the
// tax or without: the paid orders by their payments in the money journal and, until now, the
// confirmed orders that wait for their payment (db/05)
async function salesOf(
  db: Prisma.TransactionClient,
  countries: string[],
  from: Date | null,
  to: Date | null,
  withVat: boolean,
): Promise<number> {
  const [row] = await db.$queryRaw<{ sales: Prisma.Decimal | null }[]>`
    select cartlify.tax_threshold_sales(${countries}::text[], ${from}::timestamp, ${to}::timestamp, ${withVat}) as sales
  `;
  return Number(row?.sales ?? 0);
}

// the state of the threshold the database keeps now (the moment the sales of the last 12 months
// passed it is written by a confirmation of another request): read in this transaction
async function thresholdNowOf(
  db: Prisma.TransactionClient,
  country: string,
  threshold: NonNullable<ShopCountry['threshold']>,
): Promise<NonNullable<ShopCountry['threshold']>> {
  const row = await db.shopCountry.findUnique({
    where: { country },
    select: { thresholdHeldAt: true, thresholdInitialFrom: true },
  });
  return row
    ? { ...threshold, heldAt: row.thresholdHeldAt, initialFrom: row.thresholdInitialFrom }
    : threshold;
}

// the countries that share the threshold of a country: its group, or itself; none without the rule
// recipient and a threshold
function thresholdOf(country: string): { key: string; countries: string[] } | null {
  const destination = shopCountry(country);
  if (destination?.rule !== 'recipient' || !destination.threshold) return null;
  const group = destination.threshold.group;
  return {
    key: group ? `group:${group}` : `country:${destination.country}`,
    countries: group
      ? [...shopCountries().values()]
          .filter((c) => c.threshold?.group === group)
          .map((c) => c.country)
      : [destination.country],
  };
}

export const ownTaxProvider: TaxProvider = {
  name: 'own',
  label: 'The rules of the shop',

  thresholdOf,

  async quote(input, db): Promise<TaxQuote> {
    const settings = shopSettings();
    const payer = settings.vatPayer === true;
    const destination = shopCountry(input.country);
    const threshold = thresholdOf(input.country);

    let thresholdSales: number | null = null;
    let thresholdHeld = false;
    if (threshold && destination?.threshold) {
      const kept = await thresholdNowOf(db, destination.country, destination.threshold);
      const cycle = thresholdCycleOf(kept, input.at);
      thresholdSales = await salesOf(db, threshold.countries, cycle.from, null, kept.withVat);
      const previous = cycle.previousFrom
        ? await salesOf(db, threshold.countries, cycle.previousFrom, cycle.from, kept.withVat)
        : null;
      thresholdHeld = thresholdHeldOf(kept, cycle, previous);
    }

    const quote = quoteOwnTax(
      { lines: input.lines, delivery: input.delivery },
      {
        payer,
        seller: shopCountry(settings.sellerCountry),
        destination,
        thresholdSales,
        thresholdHeld,
        at: input.at,
      },
    );

    return { ...quote, threshold };
  },
};

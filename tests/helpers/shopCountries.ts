import { prisma } from '@db/client.js';
import {
  setShopCountriesForTest,
  shopCountries,
  taxGroups,
  type ShopCountry,
  type TaxGroup,
} from '@config/shopCountries.js';

import { TEST_ZONE } from './shopSettings.js';

// The countries the shop sells to (@config/shopCountries.js) in the memory of this test file only, no
// database write, the way tests/helpers/shopSettings.ts changes the data of the shop. Call
// resetShopCountries (afterEach) to put them back. Every country of a zone of the tests has a record:
// without customs and without a tax, the shop of a test that names none of the taxes

const AT = new Date('2026-01-01T00:00:00Z');

// a record of a country: without customs and without a tax unless the fields say otherwise
export const testCountry = (country: string, fields: Partial<ShopCountry> = {}): ShopCountry => ({
  country,
  customsFree: true,
  rule: null,
  registered: false,
  taxNumber: null,
  taxNumberLabel: null,
  taxNumberKind: null,
  parcelLimit: null,
  threshold: null,
  deliveryVat: null,
  exportPrice: null,
  exemptionText: null,
  rates: [],
  createdAt: AT,
  updatedAt: AT,
  ...fields,
});

// a country a parcel crosses customs to, where the buyer pays the tax on receipt
export const customsCountry = (country: string, fields: Partial<ShopCountry> = {}): ShopCountry =>
  testCountry(country, {
    customsFree: false,
    rule: 'buyer_at_receipt',
    exportPrice: 'same',
    exemptionText: 'Export outside the customs union',
    ...fields,
  });

// the countries every integration test starts with: the countries of the test zone, none with
// customs or a tax
export const INTEGRATION_COUNTRIES_BASELINE: readonly ShopCountry[] = TEST_ZONE.countries.map((c) =>
  testCountry(c),
);

// a unit test: the country of its zone
export const UNIT_COUNTRIES_BASELINE: readonly ShopCountry[] = [testCountry('UA')];

let original: { countries: ShopCountry[]; groups: TaxGroup[] } | null = null;

function remember(): void {
  if (original) return;
  try {
    original = { countries: [...shopCountries().values()], groups: [...taxGroups()] };
  } catch {
    original = { countries: [], groups: [] };
  }
}

// the records given take the place of the ones of the same countries, the rest stay
export const setShopCountries = (
  countries: readonly ShopCountry[],
  groups?: readonly TaxGroup[],
): void => {
  remember();
  let current: ShopCountry[] = [];
  let currentGroups: TaxGroup[] = [];
  try {
    current = [...shopCountries().values()];
    currentGroups = [...taxGroups()];
  } catch {
    // nothing loaded yet
  }
  const given = new Set(countries.map((c) => c.country));
  setShopCountriesForTest(
    [...current.filter((c) => !given.has(c.country)), ...countries],
    groups ?? currentGroups,
  );
};

// the countries of the zone without customs but the ones named: those cross customs (the buyer
// pays the tax on receipt there)
export const withCustoms = (...countries: string[]): void =>
  setShopCountries(countries.map((c) => customsCountry(c)));

// call it in afterEach
export const resetShopCountries = (): void => {
  if (original) setShopCountriesForTest(original.countries, original.groups);
};

// startApp applies the integration baseline once, tests/setup/unit.shopSettings.ts the unit one
// before every unit test
export function applyTestShopCountriesBaseline(countries: readonly ShopCountry[]): void {
  setShopCountriesForTest(countries, []);
}

// the records of the baseline in the database too: a real write of the data of the shop checks its
// zones against the records the database holds (checkSettings). Written by whichever file starts
// first, as root, and never changed: a file that needs other records keeps them in its memory
// (setShopCountries) or, a shopwide one, writes and removes its own
export async function ensureBaselineCountriesInDb(
  countries: readonly ShopCountry[] = INTEGRATION_COUNTRIES_BASELINE,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'select cartlify.set_current_context(\'ROOT\'::cartlify."Role", null, null)',
    );
    for (const c of countries) {
      await tx.$executeRaw`
        insert into cartlify.shop_countries (country, "customsFree")
        values (${c.country}, ${c.customsFree})
        on conflict (country) do nothing
      `;
    }
  });
}

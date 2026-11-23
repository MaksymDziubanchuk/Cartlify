import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// The tables of the taxes: the countries the shop sells to with the rule of their tax
// (shop_countries), the tax groups of the products (tax_groups, products.taxGroupId and
// taxExceptions) and the tax documents (tax_documents). Everybody reads the countries and the
// groups, only root writes them; the database checks what each rule needs, the rates and the
// groups they name, and keeps the documents as they were made. Every check runs in a transaction
// that rolls back; the checks at the end of a transaction are fired by set constraints all
// immediate

let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
let product: TestProduct;

beforeAll(async () => {
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  buyer = await createUser();
  product = await createProduct();
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, root.id, buyer.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const as = (user: TestUser): Actor => ({ role: user.role, userId: user.id });
const GUEST: Actor = { role: 'GUEST', guestId: '00000000-0000-4000-8000-000000000001' };

// a country that is not one of the zones of the tests: no other file writes it
const COUNTRY = 'XT';
const OTHER = 'XU';

type Country = Record<string, unknown>;

// a time goes to the database as text in UTC, the way a column without a zone keeps it
const UTC = "::timestamptz at time zone 'UTC'";

const castOf = (key: string) =>
  ({
    rule: '::cartlify."TaxRule"',
    taxNumberKind: '::cartlify."TaxNumberKind"',
    deliveryVat: '::cartlify."DeliveryVatRule"',
    exportPrice: '::cartlify."ExportPriceRule"',
    rates: '::jsonb',
    parcelLimit: '::numeric',
    thresholdAmount: '::numeric',
    thresholdPeriod: '::cartlify."ThresholdPeriod"',
    thresholdHeldAt: UTC,
    thresholdInitialFrom: UTC,
    createdAt: UTC,
  })[key] ?? '';

const valueOf = (key: string, value: unknown) =>
  key === 'rates' ? JSON.stringify(value) : value instanceof Date ? value.toISOString() : value;

// a country written with the values typed the way the columns take them
const writeCountry = (db: DbSession, fields: Country) => {
  const keys = Object.keys(fields);
  const columns = keys.map((k) => `"${k}"`).join(', ');
  const values = keys.map((k, i) => `$${i + 1}${castOf(k)}`).join(', ');
  return db.attempt<Country>(
    `insert into cartlify.shop_countries (${columns}) values (${values}) returning *`,
    ...keys.map((k) => valueOf(k, fields[k])),
  );
};

const updateCountry = (db: DbSession, country: string, fields: Country) => {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `"${k}" = $${i + 2}${castOf(k)}`).join(', ');
  return db.attempt<Country>(
    `update cartlify.shop_countries set ${sets} where country = $1 returning *`,
    country,
    ...keys.map((k) => valueOf(k, fields[k])),
  );
};

// the checks the database keeps to the end of the transaction, fired now
const checkDeferred = (db: DbSession) => db.attempt('set constraints all immediate');

const main = (rate: number, from: string | null = null) => ({ group: null, rate, from });
const ofGroup = (group: number, rate: number, from: string | null = null) => ({
  group,
  rate,
  from,
});

// a record of a country with the tax of the seller, the simplest one that takes a tax
const SELLER: Country = {
  country: COUNTRY,
  customsFree: true,
  rule: 'seller',
  deliveryVat: 'main',
};

// a record of a country with the tax of the recipient and nothing else it may hold
const RECIPIENT: Country = {
  country: COUNTRY,
  customsFree: true,
  rule: 'recipient',
  deliveryVat: 'proportional',
  rates: [main(20)],
};

describe('shop_countries: who reads and who writes', () => {
  it('lets root write, change and remove a country, and everybody read it', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const inserted = await writeCountry(db, SELLER);
      const updated = await updateCountry(db, COUNTRY, {
        rule: 'none',
        exportPrice: 'same',
        exemptionText: 'Art. 1',
      });

      const seen: Record<string, number> = {};
      for (const [name, actor] of [
        ['guest', GUEST],
        ['buyer', as(buyer)],
        ['admin', as(admin)],
      ] as const) {
        await db.as(actor);
        seen[name] = (
          await db.rows<{ n: number }>(
            `select count(*)::int as n from cartlify.shop_countries where country = $1`,
            COUNTRY,
          )
        )[0]!.n;
      }

      await db.as(as(root));
      const deleted = await db.attempt(
        `delete from cartlify.shop_countries where country = $1 returning country`,
        COUNTRY,
      );
      return { inserted, updated, seen, deleted };
    });

    expect(result.inserted.ok).toBe(true);
    expect(result.updated.ok && result.updated.rows[0]).toMatchObject({ rule: 'none' });
    expect(result.seen).toEqual({ guest: 1, buyer: 1, admin: 1 });
    expect(result.deleted.ok && result.deleted.rows).toHaveLength(1);
  });

  it('refuses an admin, a buyer and a guest writing a country', async () => {
    const result = await inRolledBackTx(async (db) => {
      const refusals: Record<string, string | null> = {};
      for (const [name, actor] of [
        ['admin', as(admin)],
        ['buyer', as(buyer)],
        ['guest', GUEST],
      ] as const) {
        await db.as(actor);
        const r = await writeCountry(db, SELLER);
        refusals[name] = r.ok ? 'written' : r.code;
      }

      await db.as(as(root));
      await writeCountry(db, SELLER);
      await db.as(as(admin));
      const updated = await db.rows(
        `update cartlify.shop_countries set rule = 'none' where country = $1 returning country`,
        COUNTRY,
      );
      const deleted = await db.rows(
        `delete from cartlify.shop_countries where country = $1 returning country`,
        COUNTRY,
      );
      return { refusals, updated, deleted };
    });

    expect(result.refusals).toEqual({ admin: '42501', buyer: '42501', guest: '42501' });
    // the policy hides the row from an update and a delete of an admin
    expect(result.updated).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it('keeps the time of the row and the moment a threshold held the database owns', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const inserted = await writeCountry(db, {
        ...RECIPIENT,
        thresholdAmount: 1000,
        thresholdWithVat: false,
        thresholdPeriod: 'rolling_12',
        createdAt: '2000-01-01T00:00:00Z',
        thresholdHeldAt: '2000-01-01T00:00:00Z',
      });
      const updated = await updateCountry(db, COUNTRY, { thresholdHeldAt: '2001-01-01T00:00:00Z' });
      return { inserted, updated };
    });

    expect(result.inserted.ok).toBe(true);
    const row = result.inserted.ok ? result.inserted.rows[0]! : {};
    expect(row.thresholdHeldAt).toBeNull();
    expect((row.createdAt as Date).getFullYear()).toBeGreaterThan(2000);
    // a write of root keeps it
    expect(result.updated.ok && result.updated.rows[0]!.thresholdHeldAt).toBeNull();
  });
});

describe('shop_countries: what each rule needs', () => {
  const cases: [string, Country, string][] = [
    [
      'a country with customs without a rule',
      { country: COUNTRY, customsFree: false },
      'SHOP_COUNTRY_RULE_INVALID',
    ],
    [
      'a country with customs and the tax of the seller',
      { country: COUNTRY, customsFree: false, rule: 'seller', deliveryVat: 'main' },
      'SHOP_COUNTRY_RULE_INVALID',
    ],
    [
      'a country without customs where the buyer pays on receipt',
      {
        country: COUNTRY,
        customsFree: true,
        rule: 'buyer_at_receipt',
        exportPrice: 'same',
        exemptionText: 'Export',
      },
      'SHOP_COUNTRY_RULE_INVALID',
    ],
    [
      'a registration with the tax of the seller',
      {
        ...SELLER,
        registered: true,
        taxNumber: 'GB1',
        taxNumberLabel: 'VAT',
        taxNumberKind: 'other',
      },
      'SHOP_COUNTRY_RECIPIENT_ONLY',
    ],
    [
      'a threshold with the tax of the seller',
      { ...SELLER, thresholdAmount: 10, thresholdWithVat: true },
      'SHOP_COUNTRY_RECIPIENT_ONLY',
    ],
    [
      'a registration without its number',
      { ...RECIPIENT, registered: true },
      'SHOP_COUNTRY_TAX_NUMBER_INVALID',
    ],
    [
      'a number without the registration',
      { ...RECIPIENT, taxNumber: 'GB1', taxNumberLabel: 'VAT', taxNumberKind: 'other' },
      'SHOP_COUNTRY_TAX_NUMBER_INVALID',
    ],
    [
      'a registration without the kind of its number',
      { ...RECIPIENT, registered: true, taxNumber: 'GB1', taxNumberLabel: 'VAT' },
      'SHOP_COUNTRY_TAX_NUMBER_INVALID',
    ],
    [
      'a limit of a parcel without its flags',
      { ...RECIPIENT, parcelLimit: 150 },
      'SHOP_COUNTRY_PARCEL_LIMIT_INVALID',
    ],
    [
      'a threshold without its flag',
      { ...RECIPIENT, thresholdAmount: 10000, thresholdPeriod: 'year' },
      'SHOP_COUNTRY_THRESHOLD_INVALID',
    ],
    [
      'a threshold without its period',
      { ...RECIPIENT, thresholdAmount: 10000, thresholdWithVat: false },
      'SHOP_COUNTRY_THRESHOLD_INVALID',
    ],
    [
      'a month of the last 12 months',
      {
        ...RECIPIENT,
        thresholdAmount: 10000,
        thresholdWithVat: false,
        thresholdPeriod: 'rolling_12',
        thresholdStartMonth: 4,
      },
      'SHOP_COUNTRY_THRESHOLD_INVALID',
    ],
    [
      'a group of a threshold without its sum',
      { ...RECIPIENT, thresholdGroup: 'EU' },
      'SHOP_COUNTRY_THRESHOLD_INVALID',
    ],
    [
      'a month of a year past December',
      {
        ...RECIPIENT,
        thresholdAmount: 10000,
        thresholdWithVat: false,
        thresholdPeriod: 'year',
        thresholdStartMonth: 13,
      },
      'SHOP_COUNTRY_THRESHOLD_INVALID',
    ],
    [
      'the tax of the recipient without rates',
      { ...RECIPIENT, rates: [] },
      'SHOP_COUNTRY_RATES_REQUIRED',
    ],
    [
      'the tax of the recipient across customs without the price for no tax',
      { ...RECIPIENT, customsFree: false, exemptionText: 'Export' },
      'SHOP_COUNTRY_EXPORT_PRICE_REQUIRED',
    ],
    [
      'no tax without the text for the documents',
      { country: COUNTRY, customsFree: true, rule: 'none', exportPrice: 'same' },
      'SHOP_COUNTRY_EXEMPTION_TEXT_REQUIRED',
    ],
    [
      'the tax of the seller without the way of the delivery',
      { ...SELLER, deliveryVat: null },
      'SHOP_COUNTRY_DELIVERY_VAT_REQUIRED',
    ],
    [
      'a price without the tax of the seller without the way of the delivery',
      {
        country: COUNTRY,
        customsFree: false,
        rule: 'buyer_at_receipt',
        exportPrice: 'without_seller_vat',
        exemptionText: 'Export',
      },
      'SHOP_COUNTRY_DELIVERY_VAT_REQUIRED',
    ],
  ];

  it.each(cases)('refuses %s', async (_name, fields, code) => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      return writeCountry(db, fields);
    });

    expect(result).toMatchObject({ ok: false, code: '23514', message: code });
  });

  const accepted: [string, Country][] = [
    [
      'a country without customs of a shop that takes no tax',
      { country: COUNTRY, customsFree: true },
    ],
    ['the tax of the seller', SELLER],
    [
      'the tax of the recipient with every condition',
      {
        ...RECIPIENT,
        registered: true,
        taxNumber: 'IM2760000001',
        taxNumberLabel: 'IOSS',
        taxNumberKind: 'ioss',
        parcelLimit: 150,
        parcelLimitWithDelivery: false,
        parcelLimitWithVat: false,
        thresholdAmount: 10000,
        thresholdWithVat: false,
        thresholdGroup: 'EU',
        thresholdPeriod: 'year',
      },
    ],
    [
      'the buyer paying on receipt across customs',
      {
        country: COUNTRY,
        customsFree: false,
        rule: 'buyer_at_receipt',
        exportPrice: 'same',
        exemptionText: 'Export, art. 146',
      },
    ],
    [
      'the tax of the recipient across customs',
      {
        ...RECIPIENT,
        customsFree: false,
        exportPrice: 'without_seller_vat',
        exemptionText: 'Export, art. 146',
        parcelLimit: 135,
        parcelLimitWithDelivery: false,
        parcelLimitWithVat: false,
      },
    ],
  ];

  it.each(accepted)('takes %s', async (_name, fields) => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const written = await writeCountry(db, fields);
      const deferred = await checkDeferred(db);
      return { written, deferred };
    });

    expect(result.written.ok).toBe(true);
    expect(result.deferred.ok).toBe(true);
  });
});

describe('shop_countries: the rates', () => {
  const bad: [string, unknown][] = [
    ['not a list', { group: null, rate: 20, from: null }],
    ['an entry with another field', [{ group: null, rate: 20, from: null, note: 'x' }]],
    ['a rate above 100', [main(101)]],
    ['a rate below 0', [main(-1)]],
    ['a rate past the hundredth', [main(20.005)]],
    ['a rate as text', [{ group: null, rate: '20', from: null }]],
    ['a start that is not a time', [main(20), main(21, '1 January')]],
    ['a group that starts twice at once', [main(20), main(21)]],
    ['only a planned main rate', [main(21, '2030-01-01T00:00:00.000Z')]],
  ];

  it.each(bad)('refuses rates that are %s', async (_name, rates) => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      return writeCountry(db, { ...RECIPIENT, rates });
    });

    expect(result).toMatchObject({
      ok: false,
      code: '23514',
      message: 'SHOP_COUNTRY_RATES_INVALID',
    });
  });

  it('takes a planned rate beside the one in force, and refuses a group that is not there', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const planned = await writeCountry(db, {
        ...RECIPIENT,
        rates: [main(20), main(21, '2030-01-01T00:00:00.000Z')],
      });
      const [{ max }] = await db.rows<{ max: number | null }>(
        `select max(id) as max from cartlify.tax_groups`,
      );
      const missing = await updateCountry(db, COUNTRY, {
        rates: [main(20), ofGroup((max ?? 0) + 1000, 5)],
      });
      return { planned, missing };
    });

    expect(result.planned.ok).toBe(true);
    expect(result.missing).toMatchObject({
      ok: false,
      code: '23514',
      message: 'TAX_GROUP_NOT_FOUND',
    });
  });

  it('asks a rate of every group of a country with rates by the end of the transaction', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const [group] = await db.rows<{ id: number }>(
        `insert into cartlify.tax_groups (name) values ('Books of the test') returning id`,
      );
      // a new group and the rate of a country for it in one transaction
      await writeCountry(db, { ...RECIPIENT, rates: [main(20), ofGroup(group!.id, 5)] });
      const withRate = await checkDeferred(db);
      await db.rows(`set constraints all deferred`);

      // another group without a rate in that country
      await db.rows(`insert into cartlify.tax_groups (name) values ('Medicines of the test')`);
      const groupWithout = await checkDeferred(db);
      return { withRate, groupWithout };
    });

    expect(result.withRate.ok).toBe(true);
    expect(result.groupWithout).toMatchObject({
      ok: false,
      code: '23514',
      message: 'SHOP_COUNTRY_GROUP_RATE_MISSING',
    });
  });

  it('asks the rates of a country written after its groups to name them all', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      await db.rows(`insert into cartlify.tax_groups (name) values ('Books of the test')`);
      await writeCountry(db, RECIPIENT);
      return checkDeferred(db);
    });

    expect(result).toMatchObject({
      ok: false,
      code: '23514',
      message: 'SHOP_COUNTRY_GROUP_RATE_MISSING',
    });
  });
});

describe('shop_countries: the threshold', () => {
  const threshold = {
    thresholdAmount: 10000,
    thresholdWithVat: false,
    thresholdGroup: 'EU of the test',
    thresholdPeriod: 'year',
  };

  it('asks the countries of one group to share the threshold by the end of the transaction', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      await writeCountry(db, { ...RECIPIENT, ...threshold });
      await writeCountry(db, { ...RECIPIENT, country: OTHER, ...threshold, thresholdAmount: 9000 });
      const differs = await checkDeferred(db);
      await db.rows(`set constraints all deferred`);

      // the route writes the whole group in one go
      await db.rows(
        `update cartlify.shop_countries set "thresholdAmount" = 8000 where "thresholdGroup" = $1`,
        threshold.thresholdGroup,
      );
      const same = await checkDeferred(db);
      return { differs, same };
    });

    expect(result.differs).toMatchObject({
      ok: false,
      code: '23514',
      message: 'SHOP_COUNTRY_THRESHOLD_GROUP_MISMATCH',
    });
    expect(result.same.ok).toBe(true);
  });

  // a threshold over the last 12 months holds the tax of the recipient from the sales that passed
  // it (hold_tax_threshold counts them itself), until root goes back to the first rule
  // (the hold once the sales passed it: flows/taxes.shopwide.test.ts)
  it('holds nothing while the sales of the last 12 months did not pass it, nor for a country without it, and refuses a call without an actor', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      await writeCountry(db, {
        ...RECIPIENT,
        ...threshold,
        thresholdPeriod: 'rolling_12',
        thresholdAmount: 0.01,
      });
      await writeCountry(db, {
        ...RECIPIENT,
        country: OTHER,
        ...threshold,
        thresholdPeriod: 'rolling_12',
        thresholdAmount: 0.01,
      });
      // nothing sold to the countries of the test: not passed
      await db.as(as(admin));
      const below = await db.rows<{ held: boolean }>(
        'select cartlify.hold_tax_threshold($1) as held',
        COUNTRY,
      );
      const year = await db.rows<{ held: boolean }>(
        'select cartlify.hold_tax_threshold($1) as held',
        'ZZ',
      );
      await db.as(null);
      const guest = await db.attempt('select cartlify.hold_tax_threshold($1) as held', COUNTRY);
      return { below, year, guest };
    });

    expect(result.below[0]!.held).toBe(false);
    expect(result.year[0]!.held).toBe(false);
    expect(result.guest).toMatchObject({ ok: false, code: '42501' });
  });

  it('takes the period away with the threshold', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      await writeCountry(db, { ...RECIPIENT, ...threshold, thresholdGroup: null });
      return updateCountry(db, COUNTRY, {
        thresholdAmount: null,
        thresholdWithVat: null,
        thresholdPeriod: null,
        thresholdGroup: null,
      });
    });

    expect(result.ok && result.rows[0]).toMatchObject({
      thresholdAmount: null,
      thresholdHeldAt: null,
      thresholdInitialFrom: null,
    });
  });
});

describe('tax_groups and the groups of a product', () => {
  it('lets root make, rename and remove a group, everybody read it, nobody else write it', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      const byAdmin = await db.attempt(
        `insert into cartlify.tax_groups (name) values ('Books of the test')`,
      );

      await db.as(as(root));
      const [group] = await db.rows<{ id: number }>(
        `insert into cartlify.tax_groups (name) values ('Books of the test') returning id`,
      );
      const twice = await db.attempt(
        `insert into cartlify.tax_groups (name) values ('Books of the test')`,
      );
      const untrimmed = await db.attempt(
        `insert into cartlify.tax_groups (name) values (' Books ')`,
      );
      const renamed = await db.rows(
        `update cartlify.tax_groups set name = 'Books, the test' where id = $1 returning name`,
        group!.id,
      );

      await db.as(GUEST);
      const seen = await db.rows(`select id from cartlify.tax_groups where id = $1`, group!.id);

      await db.as(as(root));
      const removed = await db.rows(
        `delete from cartlify.tax_groups where id = $1 returning id`,
        group!.id,
      );
      return { byAdmin, twice, untrimmed, renamed, seen, removed };
    });

    expect(result.byAdmin).toMatchObject({ ok: false, code: '42501' });
    expect(result.twice).toMatchObject({ ok: false, code: '23505' });
    expect(result.untrimmed).toMatchObject({ ok: false, code: '23514' });
    expect(result.renamed).toEqual([{ name: 'Books, the test' }]);
    expect(result.seen).toHaveLength(1);
    expect(result.removed).toHaveLength(1);
  });

  it('lets an admin put a product in a group and class it in another for a country', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const [books] = await db.rows<{ id: number }>(
        `insert into cartlify.tax_groups (name) values ('Books of the test') returning id`,
      );

      await db.as(as(admin));
      const set = await db.attempt<{ taxGroupId: number; taxExceptions: unknown }>(
        `update cartlify.products set "taxGroupId" = $2, "taxExceptions" = $3::jsonb
         where id = $1 returning "taxGroupId", "taxExceptions"`,
        product.id,
        books!.id,
        JSON.stringify({ DE: null, PL: books!.id }),
      );
      return { set, books: books!.id };
    });

    expect(result.set.ok && result.set.rows[0]).toEqual({
      taxGroupId: result.books,
      taxExceptions: { DE: null, PL: result.books },
    });
  });

  const badExceptions: [string, unknown, string][] = [
    ['a list', [1], 'PRODUCT_TAX_EXCEPTIONS_INVALID'],
    ['a country in small letters', { de: null }, 'PRODUCT_TAX_EXCEPTIONS_INVALID'],
    ['a group as text', { DE: '1' }, 'PRODUCT_TAX_EXCEPTIONS_INVALID'],
    ['a group that is not there', { DE: 999_999_999 }, 'TAX_GROUP_NOT_FOUND'],
  ];

  it.each(badExceptions)(
    'refuses the classes of a product that are %s',
    async (_name, exceptions, code) => {
      const result = await inRolledBackTx(async (db) => {
        await db.as(as(admin));
        return db.attempt(
          `update cartlify.products set "taxExceptions" = $2::jsonb where id = $1`,
          product.id,
          JSON.stringify(exceptions),
        );
      });

      expect(result).toMatchObject({ ok: false, code: '23514', message: code });
    },
  );

  it('keeps a group a product is in, and forgets the rates of a group that goes', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(root));
      const [books] = await db.rows<{ id: number }>(
        `insert into cartlify.tax_groups (name) values ('Books of the test') returning id`,
      );
      const [food] = await db.rows<{ id: number }>(
        `insert into cartlify.tax_groups (name) values ('Food of the test') returning id`,
      );
      await writeCountry(db, {
        ...RECIPIENT,
        rates: [main(20), ofGroup(books!.id, 5), ofGroup(food!.id, 10)],
      });

      await db.as(as(admin));
      await db.rows(
        `update cartlify.products set "taxGroupId" = $2 where id = $1`,
        product.id,
        books!.id,
      );
      await db.as(as(root));
      const asGroup = await db.attempt(`delete from cartlify.tax_groups where id = $1`, books!.id);

      await db.as(as(admin));
      await db.rows(
        `update cartlify.products set "taxGroupId" = null, "taxExceptions" = $2::jsonb where id = $1`,
        product.id,
        JSON.stringify({ DE: books!.id }),
      );
      await db.as(as(root));
      const asException = await db.attempt(
        `delete from cartlify.tax_groups where id = $1`,
        books!.id,
      );

      const unused = await db.attempt(`delete from cartlify.tax_groups where id = $1`, food!.id);
      const [{ rates }] = await db.rows<{ rates: unknown }>(
        `select rates from cartlify.shop_countries where country = $1`,
        COUNTRY,
      );
      const deferred = await checkDeferred(db);
      return { asGroup, asException, unused, rates, deferred, books: books!.id };
    });

    expect(result.asGroup).toMatchObject({ ok: false, code: '23514', message: 'TAX_GROUP_IN_USE' });
    expect(result.asException).toMatchObject({
      ok: false,
      code: '23514',
      message: 'TAX_GROUP_IN_USE',
    });
    expect(result.unused.ok).toBe(true);
    expect(result.rates).toEqual([main(20), ofGroup(result.books, 5)]);
    expect(result.deferred.ok).toBe(true);
  });
});

describe('tax_documents: only the database makes and keeps them', () => {
  it('refuses the app writing a document under any role', async () => {
    const result = await inRolledBackTx(async (db) => {
      const refusals: Record<string, string | null> = {};
      for (const [name, actor] of [
        ['root', as(root)],
        ['admin', as(admin)],
        ['buyer', as(buyer)],
      ] as const) {
        await db.as(actor);
        const r = await db.attempt(
          `insert into cartlify.tax_documents
             (kind, series, "orderId", "moneyLogId", locale, currency, seller, buyer, lines, totals, net, tax, gross)
           values ('invoice', 'F', 1, 1, 'en', 'EUR', '{}', '{}', '[]', '[]', 0, 0, 0)`,
        );
        refusals[name] = r.ok ? 'written' : r.code;
      }
      return refusals;
    });

    expect(result).toEqual({ root: '42501', admin: '42501', buyer: '42501' });
  });
});

describe('order_items: only the confirmation writes the tax', () => {
  it('drops a tax a buyer writes into a cart item', async () => {
    const result = await inRolledBackTx(async (db) => {
      await db.as(as(buyer));
      const [order] = await db.rows<{ id: number }>(
        `insert into cartlify.orders ("userId", total) values ($1, 0) returning id`,
        buyer.id,
      );
      const [item] = await db.rows<Record<string, unknown>>(
        `insert into cartlify.order_items ("orderId", "productId", "variantId", quantity, "unitPrice", "totalPrice",
           "taxRule", "taxCountry", "taxRate", "taxAmount", "listUnitPrice")
         values ($1, $2, $3, 1, 1, 1, 'none', 'DE', null, 0, 1000)
         returning "unitPrice", "taxRule", "taxCountry", "taxAmount", "listUnitPrice"`,
        order!.id,
        product.id,
        product.variantId,
      );
      const [updated] = await db.rows<Record<string, unknown>>(
        `update cartlify.order_items set "taxRule" = 'seller', "taxCountry" = 'DE', "taxRate" = 19, "taxAmount" = 1
         where "orderId" = $1 returning "taxRule", "taxAmount"`,
        order!.id,
      );
      return { item, updated };
    });

    expect(result.item).toMatchObject({
      taxRule: null,
      taxCountry: null,
      taxAmount: null,
      listUnitPrice: null,
    });
    // the price of the catalog of the factory, not the one the buyer wrote
    expect(Number(result.item!.unitPrice)).toBe(10);
    expect(result.updated).toEqual({ taxRule: null, taxAmount: null });
  });
});

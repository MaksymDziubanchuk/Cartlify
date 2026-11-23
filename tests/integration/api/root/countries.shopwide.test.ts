import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { shopCountry } from '@config/shopCountries.js';
import { shopSettings } from '@config/shopSettings.js';
import { setUserContext } from '@db/dbContext.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, testTx } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';

// The countries the shop sells to and the tax groups (docs/taxes.md): root writes a country with its
// zone of the delivery at once, takes it away, copies the classes of the products of another
// country; makes, renames and removes a tax group with its rates in every country that has rates.
// What a record may hold is checked by the database (db/taxTables.test.ts): here the route writes
// the record and the zone together, gives back the refusal of the database with its code, and keeps
// a group of a threshold together. *.shopwide.test.ts: the countries and the groups are of the
// whole shop; the file takes away what it wrote

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

// countries no other file writes
const FR = 'FR';
const IT = 'IT';
const AT = 'AT';

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct();
});

afterAll(async () => {
  try {
    for (const country of [FR, IT, AT]) await call('DELETE', `/api/root/countries/${country}`);
    const groups = (await call('GET', '/api/root/tax-groups')).json().items as { id: number }[];
    await asAdmin((tx) =>
      tx.product.update({
        where: { id: product.id },
        data: { taxGroupId: null, taxExceptions: {} },
      }),
    );
    for (const group of groups) await call('DELETE', `/api/root/tax-groups/${group.id}`);
    await closeSessions([admin.id, root.id]);
  } finally {
    await stopApp();
  }
});

const call = (
  method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  actor = root,
) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    ...(payload ? { payload } : {}),
  });

// the moment of the receipts written straight in the database, as a server with a provider left it
const receiptMomentInDatabase = (value: string | null) =>
  testTx(async (tx) => {
    await setUserContext(tx, { userId: root.id, role: 'ROOT' });
    await tx.$executeRaw`insert into cartlify.shop_settings (key, value, "setById")
      values ('receiptMoment', ${JSON.stringify(value)}::jsonb, ${root.id})`;
  });

// a record with every field, of the rule the test names
const record = (fields: Record<string, unknown> = {}) => ({
  zone: { name: 'EU of the countries test', manualPrice: 12, freeFrom: null },
  customsFree: true,
  rule: 'recipient',
  registered: false,
  taxNumber: null,
  taxNumberLabel: null,
  taxNumberKind: null,
  parcelLimit: null,
  threshold: null,
  deliveryVat: 'main',
  exportPrice: null,
  exemptionText: null,
  rates: [{ group: null, rate: 20, from: null }],
  ...fields,
});

describe('PUT /api/root/countries/:country', () => {
  it('writes the record and puts the country in its zone, made new', async () => {
    const res = await call('PUT', `/api/root/countries/${FR}`, record());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      country: FR,
      zone: { name: 'EU of the countries test', manualPrice: 12, freeFrom: null },
      rule: 'recipient',
      rates: [{ group: null, rate: 20, from: null }],
      threshold: null,
    });
    expect(
      shopSettings().deliveryZones.find((z) => z.name === 'EU of the countries test'),
    ).toMatchObject({
      countries: [FR],
    });
    expect(shopCountry(FR)).toMatchObject({ rule: 'recipient', customsFree: true });
  });

  it('puts another country in the same zone with the prices given, and keeps a threshold of a group one', async () => {
    const threshold = {
      amount: 10000,
      withVat: false,
      group: 'EU of the test',
      period: 'year',
      startMonth: null,
      nextCycle: 'recipient',
    };
    await call('PUT', `/api/root/countries/${FR}`, record({ threshold }));
    const res = await call(
      'PUT',
      `/api/root/countries/${IT}`,
      record({
        zone: { name: 'EU of the countries test', manualPrice: 14, freeFrom: 100 },
        threshold: { ...threshold, amount: 9000 },
      }),
    );

    expect(res.statusCode).toBe(200);
    const zone = shopSettings().deliveryZones.find((z) => z.name === 'EU of the countries test');
    expect(zone).toMatchObject({ countries: [FR, IT], manualPrice: 14, freeFrom: 100 });
    // the write of one country of the group wrote the others
    const fr = (await call('GET', `/api/root/countries/${FR}`)).json();
    expect(fr.threshold).toMatchObject({
      amount: 9000,
      group: 'EU of the test',
      period: 'year',
      startMonth: 1,
      nextCycle: 'recipient',
      cycleFrom: expect.any(String),
      held: false,
    });
    // the year of January: from the 1st of it, the next one a year later
    expect(
      new Date(fr.threshold.nextCycleFrom).getTime() - new Date(fr.threshold.cycleFrom).getTime(),
    ).toBeGreaterThanOrEqual(365 * 86_400_000);
  });

  it('gives back a refusal of the database with its code, and writes nothing', async () => {
    const before = shopSettings().deliveryZones;
    const res = await call(
      'PUT',
      `/api/root/countries/${AT}`,
      record({ customsFree: false, rule: 'seller' }),
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SHOP_COUNTRY_RULE_INVALID' });
    expect((await call('GET', `/api/root/countries/${AT}`)).statusCode).toBe(404);
    expect(shopSettings().deliveryZones).toEqual(before);
  });

  it('refuses a write the settings do not take: a country of a zone the app does not know', async () => {
    const res = await call('PUT', '/api/root/countries/ZZ', record());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_COUNTRY_NOT_SUPPORTED' });
  });

  // the server of the tests makes no receipts (RECEIPT_PROVIDER none): a moment the database still
  // holds is one a provider of before left; root writes it again before the data of the shop
  it('refuses a write while the shop holds a moment of the receipts the server makes none of', async () => {
    await receiptMomentInDatabase('payment');
    try {
      const res = await call('PUT', `/api/root/countries/${AT}`, record());

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'RECEIPT_MOMENT_WITHOUT_PROVIDER' });
      expect((await call('GET', `/api/root/countries/${AT}`)).statusCode).toBe(404);
    } finally {
      await receiptMomentInDatabase(null);
    }
  });

  it('keeps out an admin', async () => {
    const res = await call('PUT', `/api/root/countries/${AT}`, record(), admin);
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/root/countries/:country and the copy of the classes', () => {
  it('copies the classes of the products of another country', async () => {
    const group = (
      await call('POST', '/api/root/tax-groups', {
        name: 'Books of the countries test',
        rates: { FR: 5.5, IT: 4 },
      })
    ).json();
    await asAdmin((tx) =>
      tx.product.update({ where: { id: product.id }, data: { taxExceptions: { FR: group.id } } }),
    );

    const res = await call('POST', `/api/root/countries/${IT}/copy-exceptions`, { from: FR });
    const same = await call('POST', `/api/root/countries/${IT}/copy-exceptions`, { from: IT });

    expect(res.statusCode).toBe(200);
    expect(res.json().products).toBeGreaterThanOrEqual(1);
    const row = await asAdmin((tx) =>
      tx.product.findUnique({ where: { id: product.id }, select: { taxExceptions: true } }),
    );
    expect(row!.taxExceptions).toEqual({ FR: group.id, IT: group.id });
    expect(same.json()).toMatchObject({ errorCode: 'SHOP_COUNTRY_COPY_SAME' });
  });

  it('takes a country away with its place in the zone, and the zone left without a country', async () => {
    await call(
      'PUT',
      `/api/root/countries/${AT}`,
      // the tax of the seller: no rates, so the groups made above ask none of it
      record({
        zone: { name: 'Alone of the test', manualPrice: 1, freeFrom: null },
        rule: 'seller',
        rates: [],
      }),
    );
    const res = await call('DELETE', `/api/root/countries/${AT}`);
    const again = await call('DELETE', `/api/root/countries/${AT}`);

    expect(res.statusCode).toBe(204);
    expect(
      shopSettings().deliveryZones.find((z) => z.name === 'Alone of the test'),
    ).toBeUndefined();
    expect(again.json()).toMatchObject({ errorCode: 'SHOP_COUNTRY_NOT_FOUND' });
  });
});

describe('the tax groups', () => {
  it('asks the rate of every country with rates, and none of a country without', async () => {
    const missing = await call('POST', '/api/root/tax-groups', {
      name: 'Food of the test',
      rates: { FR: 5.5 },
    });
    const unknown = await call('POST', '/api/root/tax-groups', {
      name: 'Food of the test',
      rates: { FR: 5.5, IT: 4, UA: 7 },
    });

    expect(missing.json()).toMatchObject({
      errorCode: 'TAX_GROUP_RATES_MISSING',
      details: { countries: [IT] },
    });
    expect(unknown.json()).toMatchObject({
      errorCode: 'TAX_GROUP_RATES_UNKNOWN',
      details: { countries: ['UA'] },
    });
  });

  it('makes a group with its rates, renames it, refuses a name taken, and keeps a group in use', async () => {
    const made = await call('POST', '/api/root/tax-groups', {
      name: 'Medicines of the test',
      rates: { FR: 2.1, IT: 10 },
    });
    const group = made.json();
    const taken = await call('POST', '/api/root/tax-groups', {
      name: 'Medicines of the test',
      rates: { FR: 2.1, IT: 10 },
    });
    const renamed = await call('PATCH', `/api/root/tax-groups/${group.id}`, {
      name: 'Drugs of the test',
    });

    await asAdmin((tx) =>
      tx.product.update({ where: { id: product.id }, data: { taxGroupId: group.id } }),
    );
    const inUse = await call('DELETE', `/api/root/tax-groups/${group.id}`);
    const listed = (await call('GET', '/api/root/tax-groups')).json().items;

    expect(made.statusCode).toBe(201);
    expect(shopCountry(FR)!.rates).toContainEqual({ group: group.id, rate: 2.1, from: null });
    expect(taken.json()).toMatchObject({ errorCode: 'TAX_GROUP_NAME_TAKEN' });
    expect(renamed.json()).toMatchObject({ name: 'Drugs of the test' });
    expect(inUse.json()).toMatchObject({ errorCode: 'TAX_GROUP_IN_USE' });
    expect(listed.find((g: { id: number }) => g.id === group.id)).toMatchObject({ products: 1 });

    await asAdmin((tx) =>
      tx.product.update({ where: { id: product.id }, data: { taxGroupId: null } }),
    );
    const removed = await call('DELETE', `/api/root/tax-groups/${group.id}`);
    expect(removed.statusCode).toBe(204);
    expect(shopCountry(FR)!.rates.some((r) => r.group === group.id)).toBe(false);
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { inCommittedTx, testTx, type DbSession } from '../../../helpers/db.js';
import { begun, settledOf, shopCancelOf } from '../../../helpers/dbMoney.js';
import { invoicedOrderOf } from '../../../helpers/dbTaxDocuments.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { setUserContext } from '@db/dbContext.service.js';

// The report of the tax for the declarations (GET /api/admin/reports/vat, docs/taxes.md): the tax of
// the money of a period from the money journal, by the rule, the country and the rate: the sales,
// the money that went back to the buyers, the money that came back to the shop after it, and all of
// it together; a country taxed by the rule recipient names the tax number root wrote for it. The
// report reads every line of the journal of the period: *.shopwide.test.ts, its orders are the only
// money of the period. The orders are made in the database the way the confirmation and the payment
// write them (their tax given), each committed

let app: FastifyInstance;
let root: TestUser;
let admin: TestUser;
let buyer: TestUser;
let product: TestProduct;

// the period of the test, by the clock of the database
let from: Date;
let to: Date;

// the record of Germany as it was, put back at the end
let germany: Record<string, unknown> | null = null;

const commit = <T>(fn: (db: DbSession) => Promise<T>) => inCommittedTx(fn);

const dbNow = () =>
  testTx(async (tx) => {
    const [row] = await tx.$queryRaw<{ now: Date }[]>`select now() as now`;
    return row!.now;
  });

// a paid order of two units at 10 and a delivery of 5, taxed by the rule in the country at the rate
const paid = (tax: { rule: string; country: string; rate: number | null }) =>
  commit((db) =>
    invoicedOrderOf(
      db,
      { buyerId: buyer.id, adminId: admin.id, variantId: product.variantId },
      false,
      tax,
    ),
  );

// the whole order cancelled and refunded, the refund sent; the money comes back when it fails after
async function refunded(orderId: number, failsAfter = false) {
  const refund = await commit(async (db) => {
    const returnId = await shopCancelOf(db, admin.id, orderId);
    const transfer = await begun(db, admin.id, returnId);
    const refundId = `re_vat_${orderId}`;
    await settledOf(db, transfer.key as string, refundId, 'succeeded');
    return { key: transfer.key as string, refundId };
  });
  if (failsAfter) {
    await commit((db) => settledOf(db, refund.key, refund.refundId, 'failed'));
  }
}

beforeAll(async () => {
  app = await startApp();
  root = await createUser({ role: 'ROOT' });
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
  product = await createProduct({ price: 10, stock: 40 });

  // Germany taxed by the rule recipient, the shop registered there
  germany = await testTx(async (tx) => {
    await setUserContext(tx, { userId: root.id, role: 'ROOT' });
    const [row] = await tx.$queryRaw<{ j: Record<string, unknown> }[]>`
      select to_jsonb(c) as j from cartlify.shop_countries as c where c.country = 'DE'`;
    await tx.$executeRaw`
      update cartlify.shop_countries
      set rule = 'recipient', registered = true, "taxNumber" = 'DE123456789',
          "taxNumberLabel" = 'USt-IdNr.', "taxNumberKind" = 'other', "deliveryVat" = 'main',
          rates = '[{"group": null, "rate": 19, "from": null}]'::jsonb
      where country = 'DE'`;
    return row?.j ?? null;
  });

  from = await dbNow();
  // Spain by the rule seller at 21 %, Germany by the rule recipient at 19 %, Great Britain without
  // the tax; the Spanish order refunded, the German refund failed after it was sent
  const spain = await paid({ rule: 'seller', country: 'ES', rate: 21 });
  const de = await paid({ rule: 'recipient', country: 'DE', rate: 19 });
  await paid({ rule: 'none', country: 'GB', rate: null });
  await refunded(spain);
  await refunded(de, true);
  to = new Date((await dbNow()).getTime() + 1000);
});

afterAll(async () => {
  try {
    if (germany) {
      await testTx(async (tx) => {
        await setUserContext(tx, { userId: root.id, role: 'ROOT' });
        await tx.$executeRaw`
          update cartlify.shop_countries as c
          set rule = (${JSON.stringify(germany)}::jsonb ->> 'rule')::cartlify."TaxRule",
              registered = (${JSON.stringify(germany)}::jsonb ->> 'registered')::boolean,
              "taxNumber" = ${JSON.stringify(germany)}::jsonb ->> 'taxNumber',
              "taxNumberLabel" = ${JSON.stringify(germany)}::jsonb ->> 'taxNumberLabel',
              "taxNumberKind" = (${JSON.stringify(germany)}::jsonb ->> 'taxNumberKind')::cartlify."TaxNumberKind",
              "deliveryVat" = (${JSON.stringify(germany)}::jsonb ->> 'deliveryVat')::cartlify."DeliveryVatRule",
              rates = ${JSON.stringify(germany)}::jsonb -> 'rates'
          where c.country = 'DE'`;
      });
    }
    await closeSessions([root.id, admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const reportOf = (
  actor: TestUser | null,
  query = `?from=${from.toISOString()}&to=${to.toISOString()}`,
) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/reports/vat${query}`,
    headers: actor ? { cookie: accessCookie(actor) } : {},
  });

// 2 x 10 and 5 at 21 %: 3.47 and 0.87; at 19 %: 3.19 and 0.80
const ES = {
  rule: 'seller',
  country: 'ES',
  taxNumber: null,
  rate: 21,
  net: 20.66,
  tax: 4.34,
  gross: 25,
};
const DE = {
  rule: 'recipient',
  country: 'DE',
  taxNumber: 'DE123456789',
  rate: 19,
  net: 21.01,
  tax: 3.99,
  gross: 25,
};
const GB = { rule: 'none', country: 'GB', taxNumber: null, rate: null, net: 25, tax: 0, gross: 25 };
const negative = <T extends { net: number; tax: number; gross: number }>(row: T): T => ({
  ...row,
  net: -row.net,
  tax: -row.tax,
  gross: -row.gross,
});

describe('GET /api/admin/reports/vat', () => {
  it('gives the tax of the sales, of the money that went back and came back, by the rule, the country and the rate', async () => {
    const res = await reportOf(admin);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      from: from.toISOString(),
      to: to.toISOString(),
      currency: 'EUR',
      sales: [ES, DE, GB],
      returns: [negative(ES), negative(DE)],
      failures: [DE],
      // Spain went back whole, Germany came back after it went
      total: [{ ...ES, net: 0, tax: 0, gross: 0 }, DE, GB],
    });
  });

  it('is the same for root, and keeps an event in the period it happened in', async () => {
    const before = await reportOf(root, `?from=1970-01-01T00:00:00.000Z&to=${from.toISOString()}`);
    const all = await reportOf(root);

    expect(before.statusCode).toBe(200);
    // the orders of the test are not in a period that ended before them
    expect(before.json().sales).not.toContainEqual(DE);
    expect(all.json().sales).toEqual([ES, DE, GB]);
  });

  it('is for admins and root only: a buyer and a guest get INSUFFICIENT_ROLE', async () => {
    for (const res of [await reportOf(buyer), await reportOf(null)]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    }
  });

  it('refuses a period that ends before it starts: INVALID_STATS_PERIOD', async () => {
    const res = await reportOf(admin, `?from=${to.toISOString()}&to=${from.toISOString()}`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'INVALID_STATS_PERIOD' });
  });
});

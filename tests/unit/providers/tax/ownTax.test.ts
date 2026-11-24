import { describe, expect, it } from '@jest/globals';

import type { ShopCountry, TaxRateEntry } from '@config/shopCountries.js';
import {
  quoteOwnTax,
  shareInCents,
  taxInCents,
  type OwnTaxContext,
  type OwnTaxInput,
} from '@providers/tax/own/ownTax.js';
import type { TaxLineInput } from '@providers/tax/types.js';

// The arithmetic of our own tax: the tax a line holds half up to the cent, the shares of a sum with
// the rule of the remainder, the rule a sale goes by from the record of its country (the tax of the
// seller, of the recipient with its threshold and limit, none, the buyer on receipt), the prices a
// rule without the tax of the seller leaves, and the tax of the delivery

const AT = new Date('2026-11-21T12:00:00Z');
const BOOKS = 7;

const country = (fields: Partial<ShopCountry> & { country: string }): ShopCountry => ({
  customsFree: true,
  rule: null,
  registered: false,
  taxNumber: null,
  taxNumberLabel: null,
  taxNumberKind: null,
  parcelLimit: null,
  threshold: null,
  deliveryVat: 'main',
  exportPrice: null,
  exemptionText: null,
  rates: [],
  createdAt: AT,
  updatedAt: AT,
  ...fields,
});

const rate = (group: number | null, value: number, from: string | null = null): TaxRateEntry => ({
  group,
  rate: value,
  from,
});

// the shop in Germany: 19 %, books 7 %
const DE = country({
  country: 'DE',
  rule: 'seller',
  rates: [rate(null, 19), rate(BOOKS, 7)],
});

const line = (
  key: number,
  unitPrice: number,
  quantity = 1,
  extra: Partial<TaxLineInput> = {},
): TaxLineInput => ({
  key,
  productId: key,
  groupId: null,
  exceptions: {},
  quantity,
  unitPrice,
  ...extra,
});

const ctxOf = (
  destination: ShopCountry | null,
  extra: Partial<OwnTaxContext> = {},
): OwnTaxContext => ({
  payer: true,
  seller: DE,
  destination,
  thresholdSales: null,
  at: AT,
  ...extra,
});

const flat =
  (price: number | null, freeFrom: number | null = null): OwnTaxInput['delivery'] =>
  () => ({ flat: price, freeFrom });

describe('taxInCents and shareInCents', () => {
  it('takes the tax out of a gross price half up to the cent', () => {
    expect(taxInCents(1210, 21)).toBe(210);
    // 2.97 * 21 / 121 = 0.5155
    expect(taxInCents(297, 21)).toBe(52);
    // 1.23 * 20 / 120 = 0.205: exactly half a cent goes up
    expect(taxInCents(123, 20)).toBe(21);
    // ten pieces of 1.00 at 23 % as one line: 1.8699
    expect(taxInCents(1000, 23)).toBe(187);
    expect(taxInCents(1000, 0)).toBe(0);
    expect(taxInCents(0, 19)).toBe(0);
    // a rate to the hundredth: 5.5 %
    expect(taxInCents(1055, 5.5)).toBe(55);
  });

  it('shares a sum in proportion, the last part taking the rest', () => {
    expect(shareInCents(1000, [1, 1, 1])).toEqual([333, 333, 334]);
    expect(shareInCents(600, [100, 50])).toEqual([400, 200]);
    expect(shareInCents(500, [0, 0])).toEqual([0, 500]);
    expect(shareInCents(500, [])).toEqual([]);
  });
});

describe('quoteOwnTax: the tax of the seller', () => {
  it('takes the rate of the group of each product and of its class in the country', () => {
    const quote = quoteOwnTax(
      {
        lines: [
          line(1, 11.9, 2),
          line(2, 10.7, 1, { groupId: BOOKS }),
          // a book that Germany classes with the main rate
          line(3, 11.9, 1, { groupId: BOOKS, exceptions: { DE: null } }),
        ],
        delivery: flat(5.95),
      },
      ctxOf(DE),
    );

    expect(quote.rule).toBe('seller');
    expect(quote.country).toBe('DE');
    expect(quote.lines.map((l) => [l.rate, l.total, l.tax, l.groupId])).toEqual([
      [19, 23.8, 3.8, null],
      [7, 10.7, 0.7, BOOKS],
      [19, 11.9, 1.9, null],
    ]);
    expect(quote.delivery).toMatchObject({
      price: 5.95,
      parts: [{ rate: 19, gross: 5.95, tax: 0.95 }],
      tax: 0.95,
    });
    expect(quote.totals).toEqual([
      { rate: 7, net: 10, tax: 0.7, gross: 10.7 },
      { rate: 19, net: 35, tax: 6.65, gross: 41.65 },
    ]);
    expect(quote.total).toBe(52.35);
    expect(quote.refusal).toBeNull();
    expect(quote.payOnReceipt).toBe(false);
  });

  it('shares the delivery by the rates of the items when root asked for it', () => {
    const own = country({ ...DE, deliveryVat: 'proportional' });
    const quote = quoteOwnTax(
      { lines: [line(1, 100), line(2, 50, 1, { groupId: BOOKS })], delivery: flat(6) },
      ctxOf(own, { seller: own }),
    );

    expect(quote.delivery!.parts).toEqual([
      { rate: 7, gross: 2, tax: 0.13 },
      { rate: 19, gross: 4, tax: 0.64 },
    ]);
  });

  it('takes the rate in force at the moment, a planned one once its day has come', () => {
    const planned = country({
      ...DE,
      rates: [rate(null, 19), rate(null, 21, '2027-01-01T00:00:00.000Z')],
    });
    const before = quoteOwnTax(
      { lines: [line(1, 121)], delivery: null },
      ctxOf(planned, { seller: planned }),
    );
    const after = quoteOwnTax(
      { lines: [line(1, 121)], delivery: null },
      ctxOf(planned, { seller: planned, at: new Date('2027-01-01T00:00:00Z') }),
    );

    expect(before.lines[0]).toMatchObject({ rate: 19, tax: 19.32 });
    expect(after.lines[0]).toMatchObject({ rate: 21, tax: 21 });
  });

  it('makes the delivery free from the sum of the items at the prices the rule leaves', () => {
    const quote = quoteOwnTax({ lines: [line(1, 50)], delivery: flat(5, 50) }, ctxOf(DE));
    expect(quote.delivery).toMatchObject({ flat: 5, price: 0, parts: [], tax: 0 });
  });
});

describe('quoteOwnTax: the tax of the recipient', () => {
  const FR = country({
    country: 'FR',
    rule: 'recipient',
    registered: true,
    taxNumber: 'FR1',
    taxNumberLabel: 'TVA',
    taxNumberKind: 'other',
    rates: [rate(null, 20), rate(BOOKS, 5.5)],
    threshold: {
      amount: 10000,
      withVat: false,
      group: 'EU',
      period: 'year',
      startMonth: 1,
      initialFrom: null,
      heldAt: null,
    },
  });

  it('keeps the tax of the seller below the threshold', () => {
    const quote = quoteOwnTax(
      { lines: [line(1, 119)], delivery: null },
      ctxOf(FR, { thresholdSales: 5000 }),
    );
    expect(quote).toMatchObject({ rule: 'seller', country: 'DE', refusal: null });
    expect(quote.lines[0]).toMatchObject({ rate: 19, tax: 19 });
  });

  it('switches to the tax of the recipient on the sale that passes the threshold', () => {
    // 9950 sold, this order is 100 without the tax of France: 10050 passes 10000
    const quote = quoteOwnTax(
      { lines: [line(1, 120)], delivery: null },
      ctxOf(FR, { thresholdSales: 9950 }),
    );
    expect(quote).toMatchObject({ rule: 'recipient', country: 'FR', refusal: null });
    expect(quote.lines[0]).toMatchObject({ rate: 20, tax: 20, country: 'FR' });
  });

  // the cycle before passed it (a year), or the last 12 months hold it: the tax of the recipient from
  // the first sale, whatever the sales of the cycle now
  it('takes the tax of the recipient below the threshold when the threshold holds from before', () => {
    const quote = quoteOwnTax(
      { lines: [line(1, 120)], delivery: null },
      ctxOf(FR, { thresholdSales: 0, thresholdHeld: true }),
    );
    expect(quote).toMatchObject({ rule: 'recipient', country: 'FR', refusal: null });
  });

  it('stops the sale that would pass the threshold where the shop is not registered', () => {
    const unregistered = country({
      ...FR,
      registered: false,
      taxNumber: null,
      taxNumberLabel: null,
      taxNumberKind: null,
    });
    const quote = quoteOwnTax(
      { lines: [line(1, 120)], delivery: null },
      ctxOf(unregistered, { thresholdSales: 9950 }),
    );
    expect(quote.refusal).toEqual({ code: 'TAX_SALES_STOPPED' });
  });

  it('takes the tax of the recipient from the first sale when no condition is written', () => {
    const always = country({ ...FR, threshold: null });
    const quote = quoteOwnTax({ lines: [line(1, 120)], delivery: null }, ctxOf(always));
    expect(quote.rule).toBe('recipient');
  });

  // Britain: customs, the tax of the recipient up to 135 a parcel without the delivery and the tax
  const GB = country({
    country: 'GB',
    customsFree: false,
    rule: 'recipient',
    registered: true,
    taxNumber: 'GB1',
    taxNumberLabel: 'UK VAT',
    taxNumberKind: 'other',
    rates: [rate(null, 20)],
    parcelLimit: { amount: 135, withDelivery: false, withVat: false },
    exportPrice: 'without_seller_vat',
    exemptionText: 'Export',
  });

  it('takes the tax of the recipient for a parcel within its limit', () => {
    const quote = quoteOwnTax({ lines: [line(1, 119)], delivery: flat(10) }, ctxOf(GB));
    expect(quote).toMatchObject({ rule: 'recipient', payOnReceipt: false });
    expect(quote.lines[0]).toMatchObject({ rate: 20, unitPrice: 119, tax: 19.83 });
  });

  it('leaves the tax to the buyer on receipt above the limit, at the price without the tax of the seller', () => {
    const quote = quoteOwnTax({ lines: [line(1, 200)], delivery: flat(11.9) }, ctxOf(GB));
    expect(quote).toMatchObject({ rule: 'buyer_at_receipt', payOnReceipt: true, refusal: null });
    // 200 holds 31.93 of the 19 % of Germany
    expect(quote.lines[0]).toMatchObject({ rate: null, unitPrice: 168.07, tax: 0 });
    // the delivery the same way: 11.90 holds 1.90
    expect(quote.delivery).toMatchObject({ flat: 10, price: 10, parts: [], tax: 0 });
    expect(quote.total).toBe(178.07);
  });

  it('refuses a parcel within the limit where the shop is not registered, with the limit', () => {
    const unregistered = country({
      ...GB,
      registered: false,
      taxNumber: null,
      taxNumberLabel: null,
      taxNumberKind: null,
    });
    const quote = quoteOwnTax({ lines: [line(1, 119)], delivery: null }, ctxOf(unregistered));
    expect(quote.refusal).toEqual({
      code: 'TAX_PARCEL_LIMIT',
      limit: 135,
      withDelivery: false,
      withVat: false,
    });
  });
});

describe('quoteOwnTax: no tax, the buyer on receipt, a shop that takes no tax', () => {
  it('sells at the same price without a tax when root asked for the same price', () => {
    const none = country({
      country: 'NO',
      customsFree: true,
      rule: 'none',
      exportPrice: 'same',
      exemptionText: 'x',
    });
    const quote = quoteOwnTax({ lines: [line(1, 119)], delivery: flat(5) }, ctxOf(none));
    expect(quote).toMatchObject({ rule: 'none', country: 'NO', payOnReceipt: false });
    expect(quote.lines[0]).toMatchObject({ unitPrice: 119, tax: 0, rate: null });
    expect(quote.totals).toEqual([{ rate: null, net: 124, tax: 0, gross: 124 }]);
  });

  it('takes no tax and lowers no price for a shop that takes no tax in its own country', () => {
    const near = country({ country: 'AT', customsFree: true, rule: 'seller' });
    const far = country({
      country: 'US',
      customsFree: false,
      rule: 'buyer_at_receipt',
      exportPrice: 'without_seller_vat',
      exemptionText: 'x',
    });
    const ctx = { payer: false, seller: null };
    const nearQuote = quoteOwnTax({ lines: [line(1, 119)], delivery: null }, ctxOf(near, ctx));
    const farQuote = quoteOwnTax({ lines: [line(1, 119)], delivery: null }, ctxOf(far, ctx));

    expect(nearQuote).toMatchObject({ rule: null, country: null });
    expect(nearQuote.lines[0]).toMatchObject({ unitPrice: 119, tax: 0, rule: null });
    expect(farQuote).toMatchObject({ rule: 'buyer_at_receipt', payOnReceipt: true });
    expect(farQuote.lines[0]).toMatchObject({ unitPrice: 119, tax: 0 });
  });

  it('knows no tax for a country the shop does not sell to', () => {
    const quote = quoteOwnTax({ lines: [line(1, 10)], delivery: null }, ctxOf(null));
    expect(quote).toMatchObject({ rule: null, country: null, total: 10 });
  });
});

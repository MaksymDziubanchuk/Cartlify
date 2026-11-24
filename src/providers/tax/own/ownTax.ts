import { rateOf, type ShopCountry, type TaxRuleName } from '@config/shopCountries.js';

import {
  TAX_PARCEL_LIMIT,
  TAX_SALES_STOPPED,
  type TaxDelivery,
  type TaxLine,
  type TaxLineInput,
  type TaxQuote,
  type TaxRefusal,
  type TaxTotal,
} from '../types.js';

// The tax of a cart by our own logic, no outside service (docs/taxes.md): one function for every
// rule a country can have, the numbers and the choices being what root wrote for the countries.
// Money is counted in cents; the tax is taken out of a line (the price of the line holds it), half
// up to the cent: tax = price of the line * rate / (100 + rate). A rule without the tax of the
// seller takes it out of the unit price instead (the price is lower, it is no tax), when root asked
// for that (exportPrice without_seller_vat). The database checks the same arithmetic when the order
// is confirmed (db/05, order_items_before_ins_upd).

export const centsOf = (amount: number) => Math.round(amount * 100);
const amountOf = (cents: number) => cents / 100;
// a rate in hundredths of a percent, a whole number
const basisOf = (rate: number) => Math.round(rate * 100);

// half up of a positive fraction of whole numbers
const halfUp = (numerator: number, denominator: number) =>
  Math.floor((2 * numerator + denominator) / (2 * denominator));

// the tax a gross price in cents holds at a rate
export function taxInCents(grossCents: number, rate: number): number {
  const basis = basisOf(rate);
  if (grossCents <= 0 || basis === 0) return 0;
  return halfUp(grossCents * basis, 10_000 + basis);
}

// a sum in cents shared in proportion to the weights, each part half up and the last taking what
// is left, so the parts make the sum to the cent (the rule of the remainder)
export function shareInCents(totalCents: number, weights: readonly number[]): number[] {
  const whole = weights.reduce((sum, w) => sum + w, 0);
  if (weights.length === 0) return [];
  if (whole <= 0) return weights.map((_, i) => (i === weights.length - 1 ? totalCents : 0));

  const parts: number[] = [];
  let given = 0;
  weights.forEach((weight, i) => {
    const part = i === weights.length - 1 ? totalCents - given : halfUp(totalCents * weight, whole);
    parts.push(part);
    given += part;
  });
  return parts;
}

export type OwnTaxContext = {
  // the shop takes the tax in its own country (shopSettings().vatPayer)
  payer: boolean;
  // the record of the country of the seller, with its rates; null when root has none
  seller: ShopCountry | null;
  // the record of the country the sale goes to; null when the shop does not sell there
  destination: ShopCountry | null;
  // the sales of the period of the threshold of the destination before this order, in the measure
  // of the threshold (with the tax or without); null when it has none
  thresholdSales: number | null;
  // the tax of the recipient holds whatever the sales now (the cycle before passed the threshold,
  // or the last 12 months did since root went back to the first rule)
  thresholdHeld?: boolean;
  at: Date;
};

export type OwnTaxInput = {
  lines: readonly TaxLineInput[];
  // the price of the delivery before the rule for the items at the prices the rule leaves (the
  // price of the zone and its free-from sum, or the price of the carrier), none for a pickup
  delivery: ((itemsTotal: number) => { flat: number | null; freeFrom: number | null }) | null;
};

// the group a product is in for a country: its class there, or its own group
const groupFor = (line: TaxLineInput, country: string): number | null =>
  Object.prototype.hasOwnProperty.call(line.exceptions, country)
    ? (line.exceptions[country] ?? null)
    : line.groupId;

// the rate of the group of a product in a country; the main rate for a group the country does not
// name (the database asks a rate of every group, this only guards the edge)
const rateFor = (country: ShopCountry, line: TaxLineInput, at: Date): number | null => {
  const group = groupFor(line, country.country);
  return rateOf(country, group, at) ?? rateOf(country, null, at);
};

type Computed = {
  lines: TaxLine[];
  delivery: TaxDelivery | null;
  itemsCents: number;
  netCents: number;
  grossCents: number;
};

// the cart sold by one rule
function computeUnder(
  rule: TaxRuleName | null,
  input: OwnTaxInput,
  ctx: OwnTaxContext,
  // the country whose rates tax the sale: the seller's for the rule seller, the destination's for
  // the rule recipient; none for the rules without a tax
  taxing: ShopCountry | null,
): Computed {
  const destination = ctx.destination!;
  const lowered =
    (rule === 'none' || rule === 'buyer_at_receipt') &&
    ctx.payer &&
    ctx.seller !== null &&
    destination.exportPrice === 'without_seller_vat';

  // the rate of the seller in each line, for the price without the tax of the seller
  const sellerRates = input.lines.map((line) =>
    lowered ? (rateFor(ctx.seller!, line, ctx.at) ?? 0) : 0,
  );

  // the tax of a line in cents until the end, where it becomes an amount like the prices
  const lines: TaxLine[] = input.lines.map((line, i) => {
    const catalogCents = centsOf(line.unitPrice);
    const unitCents = lowered
      ? catalogCents - taxInCents(catalogCents, sellerRates[i]!)
      : catalogCents;
    const totalCents = unitCents * line.quantity;
    const rate = taxing ? rateFor(taxing, line, ctx.at) : null;
    const taxCents = rate === null ? 0 : taxInCents(totalCents, rate);

    return {
      key: line.key,
      rule,
      country:
        rule === null
          ? null
          : rule === 'seller'
            ? (ctx.seller?.country ?? null)
            : destination.country,
      groupId: rule === null ? null : groupFor(line, (taxing ?? destination).country),
      rate,
      unitPrice: amountOf(unitCents),
      total: amountOf(totalCents),
      tax: taxCents,
    };
  });

  const itemsCents = lines.reduce((sum, line) => sum + centsOf(line.total), 0);

  let delivery: TaxDelivery | null = null;
  if (input.delivery) {
    const { flat, freeFrom } = input.delivery(amountOf(itemsCents));
    let flatCents = flat === null ? null : centsOf(flat);

    // the price without the tax of the seller: the main rate of the seller, or the rates of the
    // items in proportion to their prices (the prices of the catalog), as root chose for the country
    if (lowered && flatCents !== null && flatCents > 0) {
      const sellerTaxCents = shareOfRates(
        flatCents,
        destination.deliveryVat,
        rateOf(ctx.seller!, null, ctx.at) ?? 0,
        input.lines.map((line, i) => ({
          rate: sellerRates[i]!,
          weight: centsOf(line.unitPrice) * line.quantity,
        })),
      ).reduce((sum, part) => sum + part.taxCents, 0);
      flatCents -= sellerTaxCents;
    }

    const free = freeFrom !== null && itemsCents >= centsOf(freeFrom);
    const priceCents = flatCents === null || free ? 0 : flatCents;

    const parts =
      taxing && priceCents > 0
        ? shareOfRates(
            priceCents,
            destination.deliveryVat,
            rateOf(taxing, null, ctx.at) ?? 0,
            lines.map((line) => ({ rate: line.rate ?? 0, weight: centsOf(line.total) })),
          ).map((part) => ({
            rate: part.rate,
            gross: amountOf(part.grossCents),
            tax: amountOf(part.taxCents),
          }))
        : [];

    delivery = {
      flat: flatCents === null ? null : amountOf(flatCents),
      freeFrom,
      price: amountOf(priceCents),
      rule,
      parts,
      tax: amountOf(parts.reduce((sum, part) => sum + centsOf(part.tax), 0)),
    };
  }

  const taxCents =
    lines.reduce((sum, line) => sum + line.tax, 0) + (delivery ? centsOf(delivery.tax) : 0);
  const grossCents = itemsCents + (delivery ? centsOf(delivery.price) : 0);

  return {
    lines: lines.map((line) => ({ ...line, tax: amountOf(line.tax) })),
    delivery,
    itemsCents,
    netCents: grossCents - taxCents,
    grossCents,
  };
}

// the tax a price holds when it is shared by rate: all at the main rate, or in proportion to the
// weights of the rates of the items (the parts of one rate together, the lowest rate first)
function shareOfRates(
  priceCents: number,
  way: ShopCountry['deliveryVat'],
  mainRate: number,
  items: readonly { rate: number; weight: number }[],
): { rate: number; grossCents: number; taxCents: number }[] {
  const byRate = new Map<number, number>();
  if (way === 'proportional') {
    for (const item of items) byRate.set(item.rate, (byRate.get(item.rate) ?? 0) + item.weight);
  }
  if (byRate.size === 0) byRate.set(mainRate, 1);

  const rates = [...byRate.keys()].sort((a, b) => a - b);
  const grosses = shareInCents(
    priceCents,
    rates.map((rate) => byRate.get(rate)!),
  );
  return rates.map((rate, i) => ({
    rate,
    grossCents: grosses[i]!,
    taxCents: taxInCents(grosses[i]!, rate),
  }));
}

// the sums by rate of a sale: the items and the delivery of one rate together, the part without a
// tax under null
function totalsOf(computed: Computed): TaxTotal[] {
  const byRate = new Map<number | null, { tax: number; gross: number }>();
  const add = (rate: number | null, grossCents: number, taxCents: number) => {
    const sum = byRate.get(rate) ?? { tax: 0, gross: 0 };
    byRate.set(rate, { tax: sum.tax + taxCents, gross: sum.gross + grossCents });
  };

  for (const line of computed.lines) add(line.rate, centsOf(line.total), centsOf(line.tax));
  if (computed.delivery) {
    if (computed.delivery.parts.length) {
      for (const part of computed.delivery.parts)
        add(part.rate, centsOf(part.gross), centsOf(part.tax));
    } else if (computed.delivery.price > 0) {
      add(null, centsOf(computed.delivery.price), 0);
    }
  }

  return [...byRate.entries()]
    .sort(([a], [b]) => (a ?? -1) - (b ?? -1))
    .map(([rate, sum]) => ({
      rate,
      net: amountOf(sum.gross - sum.tax),
      tax: amountOf(sum.tax),
      gross: amountOf(sum.gross),
    }));
}

// the rule a country falls back to when the tax of the recipient does not hold there: the tax of
// the seller without customs (none for a shop that takes no tax), the buyer pays on receipt across
// customs
const fallbackOf = (destination: ShopCountry, payer: boolean): TaxRuleName | null =>
  destination.customsFree ? (payer ? 'seller' : null) : 'buyer_at_receipt';

// the tax of a cart sent to a country
export function quoteOwnTax(input: OwnTaxInput, ctx: OwnTaxContext): Omit<TaxQuote, 'threshold'> {
  const destination = ctx.destination;

  // a country the shop does not sell to: no tax is known (the delivery refuses such a cart first)
  if (!destination) {
    return finish(
      computeUnder(null, input, { ...ctx, destination: emptyCountry() }, null),
      null,
      null,
      null,
    );
  }

  const seller = ctx.payer ? ctx.seller : null;

  let rule: TaxRuleName | null;
  let refusal: TaxRefusal | null = null;

  if (destination.rule === 'recipient') {
    const candidate = computeUnder('recipient', input, ctx, destination);
    const conditionsHold = recipientHolds(
      destination,
      candidate,
      ctx.thresholdSales,
      ctx.thresholdHeld === true,
    );

    if (!conditionsHold) {
      rule = fallbackOf(destination, ctx.payer);
    } else if (destination.registered) {
      rule = 'recipient';
    } else {
      rule = fallbackOf(destination, ctx.payer);
      refusal = destination.parcelLimit
        ? {
            code: TAX_PARCEL_LIMIT,
            limit: destination.parcelLimit.amount,
            withDelivery: destination.parcelLimit.withDelivery,
            withVat: destination.parcelLimit.withVat,
          }
        : { code: TAX_SALES_STOPPED };
    }
  } else if (destination.customsFree && !ctx.payer) {
    // a shop that takes no tax in its own country takes none where no customs stands
    rule = null;
  } else {
    rule = destination.rule ?? fallbackOf(destination, ctx.payer);
  }

  const taxing = rule === 'seller' ? seller : rule === 'recipient' ? destination : null;
  // the rule seller without the record of the seller has no rates to tax by: no tax is known
  const computed = computeUnder(rule === 'seller' && !taxing ? null : rule, input, ctx, taxing);
  const sold = rule === 'seller' && !taxing ? null : rule;
  return finish(
    computed,
    sold,
    refusal,
    sold === 'seller' ? (seller?.country ?? null) : sold ? destination.country : null,
  );
}

// the conditions root wrote for the tax of the recipient: the parcel within its limit and the sales
// of the period past the threshold with this order (or the threshold held from before), every one
// written holding (none written: from the first sale)
function recipientHolds(
  destination: ShopCountry,
  candidate: Computed,
  thresholdSales: number | null,
  thresholdHeld: boolean,
): boolean {
  if (destination.parcelLimit) {
    const { amount, withDelivery, withVat } = destination.parcelLimit;
    const items = candidate.lines.reduce(
      (sum, line) => sum + centsOf(line.total) - (withVat ? 0 : centsOf(line.tax)),
      0,
    );
    const delivery =
      withDelivery && candidate.delivery
        ? centsOf(candidate.delivery.price) - (withVat ? 0 : centsOf(candidate.delivery.tax))
        : 0;
    if (items + delivery > centsOf(amount)) return false;
  }

  if (destination.threshold && !thresholdHeld) {
    const order = destination.threshold.withVat ? candidate.grossCents : candidate.netCents;
    if (centsOf(thresholdSales ?? 0) + order <= centsOf(destination.threshold.amount)) return false;
  }

  return true;
}

function finish(
  computed: Computed,
  rule: TaxRuleName | null,
  refusal: TaxRefusal | null,
  country: string | null,
): Omit<TaxQuote, 'threshold'> {
  return {
    rule,
    country,
    lines: computed.lines,
    delivery: computed.delivery,
    totals: totalsOf(computed),
    itemsTotal: amountOf(computed.itemsCents),
    total: amountOf(computed.grossCents),
    payOnReceipt: rule === 'buyer_at_receipt',
    refusal,
  };
}

function emptyCountry(): ShopCountry {
  return {
    country: 'ZZ',
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
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

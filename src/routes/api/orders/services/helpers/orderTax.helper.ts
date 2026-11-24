import { Prisma } from '@prisma/client';

import type { DeliveryMethodName } from '@config/deliveryMethods.js';
import { shopCountry, thresholdCycleOf } from '@config/shopCountries.js';
import { shopSettings } from '@config/shopSettings.js';
import { shopToday } from '@helpers/shopDay.js';
import { carrierPriceFor, deliveryRuleOf } from '@helpers/deliveryPrice.js';
import { currentPrice } from '@helpers/productSale.js';
import { shopCurrency } from '@providers/payments/index.js';
import {
  TAX_PARCEL_LIMIT,
  TAX_SALES_STOPPED,
  taxProvider,
  type TaxLineInput,
  type TaxQuote,
} from '@providers/tax/index.js';
import { AppError, BadRequestError, ConflictError } from '@utils/errors.js';
import {
  noteParcelRefusal,
  noteSalesStopped,
} from '../../../admin/services/helpers/taxAlerts.helper.js';

// The tax of a cart for a method of the delivery (docs/taxes.md): the lines as the tax reads them,
// the country the sale is taxed in, the quote of the kind tax, what it refuses, and what the
// confirmation keeps (confirm_order, p_tax). The prices of the delivery (cartlify.delivery_price)
// are counted with the items at the prices the rule leaves.

// the price of a carrier for the parcel and the cheapest one of the address (the free-from sum of
// the zone makes the cheapest free, carrierPriceFor)
export type CarrierPrice = { price: number; cheapest: number };

// the lines of an order as the tax reads them: the price the variant sells at now (the one the
// confirmation takes; an earlier confirmation may have lowered the unit price of the item by its
// rule), the group and the classes of its product
export async function taxLinesOf(
  db: Prisma.TransactionClient,
  orderId: number,
): Promise<TaxLineInput[]> {
  const items = await db.orderItem.findMany({
    where: { orderId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      productId: true,
      quantity: true,
      variant: { select: { price: true, salePrice: true, saleEndsAt: true } },
      product: { select: { taxGroupId: true, taxExceptions: true } },
    },
  });

  return items.map((item) => ({
    key: item.id,
    productId: item.productId,
    groupId: item.product.taxGroupId,
    exceptions: (item.product.taxExceptions ?? {}) as Record<string, number | null>,
    quantity: item.quantity,
    unitPrice: currentPrice(item.variant),
  }));
}

// the country the tax of an order is of: a pickup is taxed where it is collected
export const taxCountryOf = (method: DeliveryMethodName, country: string | null): string | null =>
  method === 'pickup' ? shopSettings().pickupCountry : country;

// the price of the zone of the manual delivery to the country and its free-from sum
const manualOf = (country: string | null) => {
  const rule = deliveryRuleOf('manual', country);
  return { flat: rule.price, freeFrom: rule.freeFrom };
};

// the price of the delivery before the rule for the items at the prices the rule leaves; none for a
// pickup
function deliveryOf(
  method: DeliveryMethodName,
  country: string | null,
  carrier: CarrierPrice | null,
) {
  if (method === 'pickup') return null;
  return (itemsTotal: number) =>
    method === 'carrier'
      ? {
          flat: carrier
            ? carrierPriceFor(itemsTotal, country, carrier.price, carrier.cheapest)
            : null,
          freeFrom: null,
        }
      : manualOf(country);
}

// the tax of the cart for the method; null when there is no country to tax it in (a pickup of a
// shop that has not named the country of its place). The confirmation takes the lock of the
// threshold of the country first: two orders never pass it unseen
export async function quoteOrder(
  db: Prisma.TransactionClient,
  args: {
    lines: readonly TaxLineInput[];
    method: DeliveryMethodName;
    country: string | null;
    carrier: CarrierPrice | null;
    lock?: boolean;
  },
): Promise<TaxQuote | null> {
  const taxCountry = taxCountryOf(args.method, args.country);
  if (!taxCountry) return null;

  if (args.lock) {
    const threshold = taxProvider.thresholdOf(taxCountry);
    if (threshold) {
      await db.$executeRaw`select pg_advisory_xact_lock(hashtext(${`cartlify.tax_threshold:${threshold.key}`}))`;
    }
  }

  return taxProvider.quote(
    {
      country: taxCountry,
      lines: args.lines,
      delivery: deliveryOf(args.method, args.country, args.carrier),
      at: new Date(),
    },
    db,
  );
}

// why the order cannot go: the tax of a country where the shop is not registered (past the
// threshold; within the limit of a parcel, with the limit for the page), or a total above the
// largest one of the shop
export function refusalOf(quote: TaxQuote | null, total: number): AppError | null {
  if (quote?.refusal?.code === TAX_SALES_STOPPED) return new ConflictError(TAX_SALES_STOPPED);

  if (quote?.refusal?.code === TAX_PARCEL_LIMIT) {
    return new ConflictError(TAX_PARCEL_LIMIT, {
      limit: quote.refusal.limit,
      withDelivery: quote.refusal.withDelivery,
      withVat: quote.refusal.withVat,
      currency: shopCurrency(),
    });
  }

  const maximum = shopSettings().maxOrderTotal;
  if (maximum !== null && Math.round(total * 100) > Math.round(maximum * 100)) {
    return new BadRequestError('ORDER_TOTAL_ABOVE_MAXIMUM', { maximum, currency: shopCurrency() });
  }

  return null;
}

// what the confirmation keeps of the tax (confirm_order, p_tax); null when the shop takes none
export function taxArgOf(quote: TaxQuote | null): Record<string, unknown> | null {
  if (!quote || quote.rule === null) return null;

  return {
    items: quote.lines.map((line) => ({
      id: line.key,
      rule: line.rule,
      country: line.country,
      groupId: line.groupId,
      rate: line.rate,
      unitPrice: line.unitPrice,
      tax: line.tax,
    })),
    delivery: quote.delivery ? { rule: quote.delivery.rule, parts: quote.delivery.parts } : null,
  };
}

// what the alerts of the tax of root keep of a refusal of a confirmation (taxAlerts.helper.ts): the
// sales a threshold stopped in its period, an order refused within the limit of a parcel of the
// country on the day of the shop. Redis that cannot be asked changes nothing of the refusal
export async function noteTaxRefusal(
  quote: TaxQuote | null,
  method: DeliveryMethodName,
  country: string | null,
): Promise<void> {
  const destination = taxCountryOf(method, country);
  if (!quote?.refusal || !destination) return;
  const now = new Date();
  if (quote.refusal.code === TAX_SALES_STOPPED && quote.threshold) {
    const record = shopCountry(destination);
    const period = record?.threshold ? thresholdCycleOf(record.threshold, now).from : null;
    await noteSalesStopped(quote.threshold.key, period, now);
  } else if (quote.refusal.code === TAX_PARCEL_LIMIT) {
    await noteParcelRefusal(destination, shopToday(now.getTime()));
  }
}

import env from '@config/env.js';
import type { DeliveryMethodName } from '@config/deliveryMethods.js';

// what a buyer pays for the delivery by the settings of the shop: the manual method the flat price,
// nothing from the free-from sum of the items on (the sum itself included), a pickup nothing.
// cartlify.delivery_price in the database holds the same rule; confirm_order fixes the price there

const toCents = (amount: number) => Math.round(amount * 100);

export type DeliveryQuote = {
  method: DeliveryMethodName;
  price: number;
  // the sum of the items from which the delivery is free, empty when the shop names none
  freeFrom: number | null;
  // what the cart still lacks of it, 0 once the delivery is free
  remainingToFree: number | null;
};

export function deliveryPriceOf(method: DeliveryMethodName, itemsTotal: number): number {
  if (method !== 'manual' || env.DELIVERY_FLAT_PRICE === null) return 0;

  if (env.DELIVERY_FREE_FROM !== null && toCents(itemsTotal) >= toCents(env.DELIVERY_FREE_FROM)) {
    return 0;
  }

  return env.DELIVERY_FLAT_PRICE;
}

// each method the shop has enabled with the price it asks for these items
export function deliveryQuotesOf(itemsTotal: number): DeliveryQuote[] {
  return env.DELIVERY_METHODS.map((method) => {
    const freeFrom =
      method === 'manual' && env.DELIVERY_FLAT_PRICE !== null ? env.DELIVERY_FREE_FROM : null;

    return {
      method,
      price: deliveryPriceOf(method, itemsTotal),
      freeFrom,
      remainingToFree:
        freeFrom === null ? null : Math.max(0, toCents(freeFrom) - toCents(itemsTotal)) / 100,
    };
  });
}

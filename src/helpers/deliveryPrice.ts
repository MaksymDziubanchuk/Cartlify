import { shopSettings } from '@config/shopSettings.js';
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
  const settings = shopSettings();
  if (method !== 'manual' || settings.deliveryFlatPrice === null) return 0;

  if (
    settings.deliveryFreeFrom !== null &&
    toCents(itemsTotal) >= toCents(settings.deliveryFreeFrom)
  ) {
    return 0;
  }

  return settings.deliveryFlatPrice;
}

// each method the shop has enabled with the price it asks for these items
export function deliveryQuotesOf(itemsTotal: number): DeliveryQuote[] {
  const settings = shopSettings();
  return settings.deliveryMethods.map((method) => {
    const freeFrom =
      method === 'manual' && settings.deliveryFlatPrice !== null ? settings.deliveryFreeFrom : null;

    return {
      method,
      price: deliveryPriceOf(method, itemsTotal),
      freeFrom,
      remainingToFree:
        freeFrom === null ? null : Math.max(0, toCents(freeFrom) - toCents(itemsTotal)) / 100,
    };
  });
}

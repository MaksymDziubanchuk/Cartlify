import { shopSettings } from '@config/shopSettings.js';
import { zoneOf, type DeliveryZone } from '@config/deliveryZones.js';
import type { DeliveryMethodName } from '@config/deliveryMethods.js';

// What a buyer pays for the delivery by the zones of the shop (deliveryZones): a pickup nothing; the
// manual method the price of the zone of the country; a carrier of the delivery provider the price
// the provider gives for the parcel; every method to a zone nothing from its free-from sum of the
// items on (the sum itself included). cartlify.delivery_price in the database holds the same rule
// (confirm_order fixes the price there with the price and the sum this gives it)

const toCents = (amount: number) => Math.round(amount * 100);

export type DeliveryQuote = {
  method: DeliveryMethodName;
  // what it costs for these items to the country of the cart; null while the cart names no country
  // the shop delivers to, and for a carrier (its price comes with the carriers for the address,
  // POST /api/orders/current/delivery-options)
  price: number | null;
  // the sum of the items from which the delivery is free, empty when the zone names none
  freeFrom: number | null;
  // what the cart still lacks of it, 0 once the delivery is free
  remainingToFree: number | null;
};

// the zone of a country by the settings of the shop; null when the shop does not deliver there
export function shopZoneOf(country: string | null): DeliveryZone | null {
  return zoneOf(shopSettings().deliveryZones, country);
}

// whether a method goes to the country: a pickup has no address; the manual delivery goes to a zone
// that has a price of it, a carrier to every zone
export function methodGoesTo(method: DeliveryMethodName, country: string | null): boolean {
  if (method === 'pickup') return true;
  const zone = shopZoneOf(country);
  if (!zone) return false;
  return method === 'carrier' || zone.manualPrice !== null;
}

// the rule confirm_order is given for the method to the country: the price before the free-from sum
// (the price of the zone, or the price of the carrier the buyer picked) and that sum; nothing for a
// pickup
export function deliveryRuleOf(
  method: DeliveryMethodName,
  country: string | null,
  carrierPrice: number | null = null,
): { price: number | null; freeFrom: number | null } {
  if (method === 'pickup') return { price: null, freeFrom: null };
  // the price of a carrier is what the buyer pays for it already, the free-from sum counted in it
  // (carrierPriceFor): the rule of the database only takes it
  if (method === 'carrier') return { price: carrierPrice, freeFrom: null };
  const zone = shopZoneOf(country);
  return { price: zone?.manualPrice ?? null, freeFrom: zone?.freeFrom ?? null };
}

// what the buyer pays for a carrier of the delivery provider: its price; from the free-from sum of
// the zone the cheapest carrier is free and the others cost what they cost above it (the shop pays
// the cheapest way, the buyer the wish for another)
export function carrierPriceFor(
  itemsTotal: number,
  country: string | null,
  price: number,
  cheapest: number,
): number {
  const freeFrom = shopZoneOf(country)?.freeFrom ?? null;
  if (freeFrom === null || toCents(itemsTotal) < toCents(freeFrom)) return price;
  return Math.max(0, toCents(price) - toCents(cheapest)) / 100;
}

// what the buyer pays for the method to the country for these items: 0 for a pickup and from the
// free-from sum of the zone on, else the price of the rule; 0 when there is no price (a country the
// method does not go to is refused before a price is asked)
export function deliveryPriceOf(
  method: DeliveryMethodName,
  itemsTotal: number,
  country: string | null,
  carrierPrice: number | null = null,
): number {
  const { price, freeFrom } = deliveryRuleOf(method, country, carrierPrice);
  if (price === null) return 0;
  if (freeFrom !== null && toCents(itemsTotal) >= toCents(freeFrom)) return 0;
  return price;
}

// each method the shop has enabled with the price it asks for these items to the country of the
// cart (none known: the prices of the address methods are unknown too)
export function deliveryQuotesOf(itemsTotal: number, country: string | null): DeliveryQuote[] {
  const zone = shopZoneOf(country);

  return shopSettings().deliveryMethods.map((method) => {
    if (method === 'pickup') {
      return { method, price: 0, freeFrom: null, remainingToFree: null };
    }

    const goes = methodGoesTo(method, country);
    const freeFrom = goes ? (zone?.freeFrom ?? null) : null;
    return {
      method,
      price: goes && method === 'manual' ? deliveryPriceOf(method, itemsTotal, country) : null,
      freeFrom,
      remainingToFree:
        freeFrom === null ? null : Math.max(0, toCents(freeFrom) - toCents(itemsTotal)) / 100,
    };
  });
}

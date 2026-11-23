import { afterEach, describe, expect, it } from '@jest/globals';

import {
  carrierPriceFor,
  deliveryPriceOf,
  deliveryQuotesOf,
  deliveryRuleOf,
  methodGoesTo,
  shopZoneOf,
} from '@helpers/deliveryPrice.js';

import { resetShopSettings, setShopSettings } from '../../helpers/shopSettings.js';

import type { DeliveryMethodName } from '@config/deliveryMethods.js';
import type { DeliveryZone } from '@config/deliveryZones.js';

// what a buyer pays for the delivery by the zones of the shop: a pickup nothing; the manual method
// the price of the zone of the country; a carrier the price of the delivery provider; every method
// to a zone nothing from its free-from sum of the items on (the sum itself included).
// cartlify.delivery_price in the database holds the same rule (tests/integration/db/delivery.test.ts,
// tests/integration/db/parcels.test.ts)

afterEach(resetShopSettings);

const zone = (over: Partial<DeliveryZone>): DeliveryZone => ({
  name: 'Spain',
  countries: ['ES'],
  manualPrice: 5,
  freeFrom: null,
  ...over,
});

// the example of the owner: Spain 5, the EU 12 (free from 100), Poland 30 (no manual delivery to
// a zone of carriers only)
const shop = (
  zones: DeliveryZone[],
  methods: DeliveryMethodName[] = ['manual', 'pickup', 'carrier'],
) => {
  setShopSettings({ deliveryZones: zones, deliveryMethods: methods });
};

const OWNER_ZONES = [
  zone({}),
  zone({ name: 'EU', countries: ['FR', 'DE'], manualPrice: 12, freeFrom: 100 }),
  zone({ name: 'Rest', countries: ['PL'], manualPrice: 30 }),
];

describe('shopZoneOf', () => {
  it('finds the zone that names the country', () => {
    shop(OWNER_ZONES);

    expect(shopZoneOf('ES')!.name).toBe('Spain');
    expect(shopZoneOf('DE')!.name).toBe('EU');
    expect(shopZoneOf('PL')!.name).toBe('Rest');
  });

  it('has no zone for a country the app does not deliver to, nor for no country', () => {
    shop(OWNER_ZONES);

    expect(shopZoneOf('US')).toBeNull();
    expect(shopZoneOf(null)).toBeNull();
  });

  it('has no zone for a country outside the zones', () => {
    shop([zone({})]);

    expect(shopZoneOf('FR')).toBeNull();
  });
});

describe('methodGoesTo', () => {
  it('sends the manual delivery to a zone with a price of it, a carrier to every zone', () => {
    shop([zone({}), zone({ name: 'Far', countries: ['GB'], manualPrice: null })]);

    expect(methodGoesTo('manual', 'ES')).toBe(true);
    expect(methodGoesTo('manual', 'GB')).toBe(false);
    expect(methodGoesTo('carrier', 'GB')).toBe(true);
    expect(methodGoesTo('carrier', 'FR')).toBe(false);
    expect(methodGoesTo('pickup', null)).toBe(true);
  });
});

describe('deliveryPriceOf', () => {
  it('asks the price of the zone of the country for the manual method', () => {
    shop(OWNER_ZONES);

    expect(deliveryPriceOf('manual', 20, 'ES')).toBe(5);
    expect(deliveryPriceOf('manual', 20, 'FR')).toBe(12);
    expect(deliveryPriceOf('manual', 20, 'PL')).toBe(30);
  });

  it('asks for a carrier the price given: what the buyer pays for it already', () => {
    shop(OWNER_ZONES);

    expect(deliveryPriceOf('carrier', 20, 'FR', 7.4)).toBe(7.4);
    expect(deliveryPriceOf('carrier', 100, 'FR', 7.4)).toBe(7.4);
    expect(deliveryPriceOf('carrier', 1000, 'ES', 0)).toBe(0);
  });

  it('makes only the cheapest carrier free from the sum of the zone, another one costs what it costs above it', () => {
    shop(OWNER_ZONES);

    // below the sum: the price of the carrier
    expect(carrierPriceFor(20, 'FR', 7.4, 4)).toBe(7.4);
    // from it: the cheapest is free, another one pays the difference
    expect(carrierPriceFor(100, 'FR', 4, 4)).toBe(0);
    expect(carrierPriceFor(100, 'FR', 7.4, 4)).toBe(3.4);
    // a zone without the sum
    expect(carrierPriceFor(1000, 'ES', 7.4, 4)).toBe(7.4);
  });

  it('asks nothing for a pickup', () => {
    shop(OWNER_ZONES);

    expect(deliveryPriceOf('pickup', 20, null)).toBe(0);
  });

  it('makes the delivery free from the sum of the zone on, the sum itself included', () => {
    shop(OWNER_ZONES);

    expect(deliveryPriceOf('manual', 99.99, 'DE')).toBe(12);
    expect(deliveryPriceOf('manual', 100, 'DE')).toBe(0);
    expect(deliveryPriceOf('manual', 100.01, 'DE')).toBe(0);
  });

  it('compares in cents, not in floating numbers', () => {
    shop([zone({ freeFrom: 0.3 })]);

    // 0.1 + 0.2 is 0.30000000000000004 as a float
    expect(deliveryPriceOf('manual', 0.1 + 0.2, 'ES')).toBe(0);
    expect(deliveryPriceOf('manual', 0.29, 'ES')).toBe(5);
  });

  it('asks the price of an empty cart too: the cart shows it before anything is in it', () => {
    shop([zone({ freeFrom: 50 })]);

    expect(deliveryPriceOf('manual', 0, 'ES')).toBe(5);
  });
});

describe('deliveryRuleOf', () => {
  it('gives the database the price before the free-from sum and that sum', () => {
    shop(OWNER_ZONES);

    expect(deliveryRuleOf('manual', 'DE')).toEqual({ price: 12, freeFrom: 100 });
    // the price of a carrier has the free-from sum counted in it already
    expect(deliveryRuleOf('carrier', 'DE', 7.4)).toEqual({ price: 7.4, freeFrom: null });
    expect(deliveryRuleOf('pickup', null)).toEqual({ price: null, freeFrom: null });
  });
});

describe('deliveryQuotesOf', () => {
  it('quotes each enabled method to the country of the cart, with what is left to the free delivery', () => {
    shop(OWNER_ZONES);

    expect(deliveryQuotesOf(30, 'DE')).toEqual([
      { method: 'manual', price: 12, freeFrom: 100, remainingToFree: 70 },
      { method: 'pickup', price: 0, freeFrom: null, remainingToFree: null },
      // the price of a carrier comes with the carriers for the address
      { method: 'carrier', price: null, freeFrom: 100, remainingToFree: 70 },
    ]);
  });

  it('has no price of a delivery to an address while the cart names no country', () => {
    shop(OWNER_ZONES, ['manual', 'pickup']);

    expect(deliveryQuotesOf(30, null)).toEqual([
      { method: 'manual', price: null, freeFrom: null, remainingToFree: null },
      { method: 'pickup', price: 0, freeFrom: null, remainingToFree: null },
    ]);
  });

  it('has nothing left to the free delivery once it is free, and no sum when the zone names none', () => {
    shop(OWNER_ZONES, ['manual']);

    expect(deliveryQuotesOf(150, 'DE')).toEqual([
      { method: 'manual', price: 0, freeFrom: 100, remainingToFree: 0 },
    ]);
    expect(deliveryQuotesOf(150, 'ES')).toEqual([
      { method: 'manual', price: 5, freeFrom: null, remainingToFree: null },
    ]);
  });

  it('has no price of the manual delivery to a zone without one', () => {
    shop([zone({ manualPrice: null, freeFrom: 50 })], ['manual']);

    expect(deliveryQuotesOf(10, 'ES')).toEqual([
      { method: 'manual', price: null, freeFrom: null, remainingToFree: null },
    ]);
  });

  it('keeps the cents of what is left', () => {
    shop([zone({ freeFrom: 50 })], ['manual']);

    expect(deliveryQuotesOf(19.9, 'ES')[0]!.remainingToFree).toBe(30.1);
  });
});

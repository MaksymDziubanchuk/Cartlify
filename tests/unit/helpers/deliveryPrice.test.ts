import { afterEach, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { deliveryPriceOf, deliveryQuotesOf } from '@helpers/deliveryPrice.js';

// what a buyer pays for the delivery by the settings of the shop: the manual method the flat price,
// nothing from the free-from sum of the items on (the sum itself included), a pickup nothing.
// cartlify.delivery_price in the database holds the same rule (tests/integration/db/delivery.test.ts)

const original = {
  methods: env.DELIVERY_METHODS,
  flat: env.DELIVERY_FLAT_PRICE,
  freeFrom: env.DELIVERY_FREE_FROM,
};

afterEach(() => {
  env.DELIVERY_METHODS = original.methods;
  env.DELIVERY_FLAT_PRICE = original.flat;
  env.DELIVERY_FREE_FROM = original.freeFrom;
});

const shop = (flat: number | null, freeFrom: number | null = null) => {
  env.DELIVERY_FLAT_PRICE = flat;
  env.DELIVERY_FREE_FROM = freeFrom;
};

describe('deliveryPriceOf', () => {
  it('asks the flat price of the manual method', () => {
    shop(4.99);

    expect(deliveryPriceOf('manual', 20)).toBe(4.99);
  });

  it('asks nothing when the shop names no price', () => {
    shop(null);

    expect(deliveryPriceOf('manual', 20)).toBe(0);
  });

  it('asks nothing for a pickup', () => {
    shop(4.99, 50);

    expect(deliveryPriceOf('pickup', 20)).toBe(0);
  });

  it('makes the delivery free from the sum on, the sum itself included', () => {
    shop(4.99, 50);

    expect(deliveryPriceOf('manual', 49.99)).toBe(4.99);
    expect(deliveryPriceOf('manual', 50)).toBe(0);
    expect(deliveryPriceOf('manual', 50.01)).toBe(0);
  });

  it('compares in cents, not in floating numbers', () => {
    shop(4.99, 0.3);

    // 0.1 + 0.2 is 0.30000000000000004 as a float
    expect(deliveryPriceOf('manual', 0.1 + 0.2)).toBe(0);
    expect(deliveryPriceOf('manual', 0.29)).toBe(4.99);
  });

  it('asks the price of an empty cart too: the cart shows it before anything is in it', () => {
    shop(4.99, 50);

    expect(deliveryPriceOf('manual', 0)).toBe(4.99);
  });
});

describe('deliveryQuotesOf', () => {
  it('quotes each enabled method, with what is left to the free delivery', () => {
    env.DELIVERY_METHODS = ['manual', 'pickup'];
    shop(4.99, 50);

    expect(deliveryQuotesOf(30)).toEqual([
      { method: 'manual', price: 4.99, freeFrom: 50, remainingToFree: 20 },
      { method: 'pickup', price: 0, freeFrom: null, remainingToFree: null },
    ]);
  });

  it('has nothing left to the free delivery once it is free, and no sum when the shop names none', () => {
    env.DELIVERY_METHODS = ['manual'];
    shop(4.99, 50);
    expect(deliveryQuotesOf(80)).toEqual([
      { method: 'manual', price: 0, freeFrom: 50, remainingToFree: 0 },
    ]);

    shop(4.99, null);
    expect(deliveryQuotesOf(80)).toEqual([
      { method: 'manual', price: 4.99, freeFrom: null, remainingToFree: null },
    ]);
  });

  it('quotes only the methods the shop enabled', () => {
    env.DELIVERY_METHODS = ['pickup'];
    shop(null);

    expect(deliveryQuotesOf(10)).toEqual([
      { method: 'pickup', price: 0, freeFrom: null, remainingToFree: null },
    ]);
  });

  it('keeps the cents of what is left', () => {
    env.DELIVERY_METHODS = ['manual'];
    shop(4.99, 50);

    expect(deliveryQuotesOf(19.9)[0]!.remainingToFree).toBe(30.1);
  });
});

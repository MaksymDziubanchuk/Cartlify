import { describe, expect, it } from '@jest/globals';

import {
  BOX_MAX_SIZE_MM,
  BOX_MAX_WEIGHT_GRAMS,
  oneBoxOf,
} from '@routes/api/orders/services/helpers/parcelItems.helper.js';

// the one box of every unit: the weight summed, the biggest length and width, the heights stacked;
// a box the database cannot keep has no weight and no sizes (the admin lays the units out)
const item = (units: number, weightGrams: number, heightMm = 50) => ({
  orderItemId: 1,
  units,
  weightGrams,
  lengthMm: 300,
  widthMm: 200,
  heightMm,
});

describe('oneBoxOf', () => {
  it('stacks the units in one box', () => {
    expect(oneBoxOf([item(3, 400)])).toEqual({
      weightGrams: 1200,
      lengthMm: 300,
      widthMm: 200,
      heightMm: 150,
      items: [{ orderItemId: 1, quantity: 3 }],
    });
  });

  it('gives no weight nor sizes to a box heavier or taller than a box can be', () => {
    for (const box of [
      oneBoxOf([item(2, BOX_MAX_WEIGHT_GRAMS / 2 + 1)]),
      oneBoxOf([item(3, 400, BOX_MAX_SIZE_MM / 3 + 1)]),
    ]) {
      expect(box).toMatchObject({
        weightGrams: null,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
      });
    }
    expect(oneBoxOf([item(2, BOX_MAX_WEIGHT_GRAMS / 2)]).weightGrams).toBe(BOX_MAX_WEIGHT_GRAMS);
  });
});

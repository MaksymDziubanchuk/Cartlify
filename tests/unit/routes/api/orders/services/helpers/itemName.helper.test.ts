import { describe, expect, it } from '@jest/globals';

import { itemNameOf } from '@routes/api/orders/services/helpers/itemName.helper.js';

describe('itemNameOf', () => {
  it('gives the copy of the name the confirmation kept', () => {
    expect(
      itemNameOf({
        productName: 'Desk lamp, black',
        variantId: 21,
        product: { name: 'Desk lamp' },
      }),
    ).toBe('Desk lamp, black');
  });

  // the copy is what was bought: the name of the product now is no matter to it
  it('keeps the copy after the product is renamed', () => {
    expect(
      itemNameOf({ productName: 'Mug', variantId: 4, product: { name: 'Mug, renamed' } }),
    ).toBe('Mug');
  });

  // an item from before the names were kept goes by the name its variant has now
  it('gives the name the variant has now when the item has no copy', () => {
    expect(itemNameOf({ productName: null, variantId: 4, product: { name: 'Mug' } })).toBe('Mug');
  });
});

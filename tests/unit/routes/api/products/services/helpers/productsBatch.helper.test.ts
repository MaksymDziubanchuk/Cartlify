import { describe, expect, it } from '@jest/globals';

import {
  clashingSkus,
  refusalOfProduct,
  refuseTogether,
  repeatedProductIds,
} from '@routes/api/products/services/helpers/productsBatch.helper.js';
import { BadRequestError, ConflictError, NotFoundError } from '@utils/errors.js';

import { rejectedBy } from '../../../../../../helpers/errors.js';

// a change of many products is all or nothing: a refusal names every product refused the same way
// (details.products), the first product refused names the code

type Item = { productId: number; refuse?: Error };

const check = (item: Item) => {
  if (item.refuse) throw item.refuse;
  return item.productId * 10;
};

const run = (items: Item[]) => refuseTogether(items, (item) => item.productId, check);

describe('refuseTogether', () => {
  it('gives the result of each item in its order when none is refused', async () => {
    await expect(run([{ productId: 3 }, { productId: 1 }])).resolves.toEqual([30, 10]);
  });

  it('waits for a check that answers later', async () => {
    const items = [{ productId: 2 }, { productId: 5 }];

    await expect(
      refuseTogether(
        items,
        (item) => item.productId,
        async (item) => item.productId + 1,
      ),
    ).resolves.toEqual([3, 6]);
  });

  it('names every product refused with the code of the first one, with the details of each', async () => {
    const err = await rejectedBy(() =>
      run([
        { productId: 1 },
        {
          productId: 2,
          refuse: new ConflictError('PRODUCT_SALE_DECISION_REQUIRED', { salePrice: 5 }),
        },
        { productId: 3, refuse: new NotFoundError('CATEGORY_NOT_FOUND') },
        {
          productId: 4,
          refuse: new ConflictError('PRODUCT_SALE_DECISION_REQUIRED', { salePrice: 7 }),
        },
      ]),
    );

    expect(err).toMatchObject({
      statusCode: 409,
      errorCode: 'PRODUCT_SALE_DECISION_REQUIRED',
      details: {
        products: [
          { productId: 2, salePrice: 5 },
          { productId: 4, salePrice: 7 },
        ],
      },
    });
  });

  it('lets an error that is no refusal through as it is', async () => {
    const broken = new Error('connection lost');

    const err = await rejectedBy(() =>
      run([
        { productId: 1, refuse: new BadRequestError('PRODUCT_NAME_INVALID') },
        { productId: 2, refuse: broken },
      ]),
    );

    expect(err).toBe(broken);
  });
});

describe('refusalOfProduct', () => {
  it('keeps the status and the code and names the product with its details', () => {
    const err = refusalOfProduct(
      7,
      new BadRequestError('PRODUCT_SALE_AMOUNT_TOO_HIGH', { price: 4 }),
    );

    expect(err).toMatchObject({
      statusCode: 400,
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { products: [{ productId: 7, price: 4 }] },
    });
  });

  it('names the product alone for a refusal without details', () => {
    expect(refusalOfProduct(7, new ConflictError('PRODUCT_SKU_TAKEN'))).toMatchObject({
      statusCode: 409,
      details: { products: [{ productId: 7 }] },
    });
  });
});

describe('repeatedProductIds', () => {
  it('names each product given more than once, once', () => {
    expect(repeatedProductIds([4, 2, 4, 9, 2, 4])).toEqual([4, 2]);
  });

  it('is empty when each product comes once', () => {
    expect(repeatedProductIds([1, 2, 3])).toEqual([]);
  });
});

describe('clashingSkus', () => {
  it('names a product that takes an article number another product holds', () => {
    expect(
      clashingSkus(
        [
          { productId: 1, lowered: 'a-1' },
          { productId: 2, lowered: 'b-2' },
        ],
        new Set(['a-1']),
      ),
    ).toEqual([1]);
  });

  it('names every product of the request that takes the same article number', () => {
    expect(
      clashingSkus(
        [
          { productId: 1, lowered: 'x' },
          { productId: 2, lowered: 'y' },
          { productId: 3, lowered: 'x' },
        ],
        new Set(),
      ),
    ).toEqual([1, 3]);
  });

  it('lets products swap their article numbers and take theirs away', () => {
    expect(
      clashingSkus(
        [
          { productId: 1, lowered: 'b' },
          { productId: 2, lowered: 'a' },
          { productId: 3, lowered: null },
          { productId: 4, lowered: null },
        ],
        new Set(),
      ),
    ).toEqual([]);
  });
});

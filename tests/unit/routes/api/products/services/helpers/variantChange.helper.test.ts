import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  assertForSale,
  checkEveryVariant,
  checkVariantChange,
  refusalOfVariants,
  type VariantChangeRow,
} from '@routes/api/products/services/helpers/variantChange.helper.js';
import { planVariantsChange } from '@routes/api/products/services/helpers/variantInput.helper.js';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '@utils/errors.js';

import { rejectedBy, thrownBy } from '../../../../../../helpers/errors.js';

// the checks of the change of a variant against the variant as it is, and the refusal of a change of
// many variants that names every variant refused

const DAY = 86_400_000;
const ahead = () => new Date(Date.now() + DAY);
const behind = () => new Date(Date.now() - DAY);
const dec = (value: number) => new Prisma.Decimal(value);

const variant = (over: Partial<VariantChangeRow> = {}): VariantChangeRow => ({
  id: 7,
  productId: 3,
  price: dec(20),
  salePrice: null,
  saleEndsAt: null,
  salePriorPrice: null,
  weightGrams: null,
  lengthMm: null,
  widthMm: null,
  heightMm: null,
  deletedAt: null,
  ...over,
});

const onSale = (over: Partial<VariantChangeRow> = {}) =>
  variant({ salePrice: dec(15), saleEndsAt: ahead(), ...over });

const live: { deletedAt: Date | null } = { deletedAt: null };

const sale = (word: 'keep' | 'remove' | 'new', amount = 5) => ({
  sale: word === 'new' ? { amount, endsAt: ahead().toISOString() } : (word as 'keep' | 'remove'),
});

describe('assertForSale', () => {
  it('lets a variant for sale of a product in the catalog through', () => {
    expect(() => assertForSale(variant(), live)).not.toThrow();
  });

  it('refuses a product that is out of the catalog, before the variant', () => {
    expect(
      thrownBy(() => assertForSale(variant({ deletedAt: new Date() }), { deletedAt: new Date() })),
    ).toMatchObject({
      statusCode: 404,
      errorCode: 'PRODUCT_NOT_FOUND',
    });
  });

  it('refuses a variant that is taken out of sale', () => {
    expect(thrownBy(() => assertForSale(variant({ deletedAt: new Date() }), live))).toMatchObject({
      statusCode: 404,
      errorCode: 'VARIANT_NOT_FOUND',
    });
  });
});

describe('checkVariantChange', () => {
  const check = (before: VariantChangeRow, fields: Record<string, unknown>, product = live) =>
    checkVariantChange(before, product, planVariantsChange(fields));

  it('lets a new price of a variant without a sale through', () => {
    expect(() => check(variant(), { price: 25 })).not.toThrow();
  });

  it('lets the same price of a variant on sale through without a word on the sale', () => {
    expect(() => check(onSale(), { price: 20, weightGrams: 5 })).not.toThrow();
  });

  it('lets a change that leaves the price of a variant on sale through without a word', () => {
    expect(() => check(onSale(), { weightGrams: 5 })).not.toThrow();
  });

  it('asks for a word on the sale when the price of a variant on sale changes', () => {
    expect(thrownBy(() => check(onSale(), { price: 25 }))).toMatchObject({
      statusCode: 409,
      errorCode: 'PRODUCT_SALE_DECISION_REQUIRED',
      details: { salePrice: 15, saleEndsAt: expect.any(String) },
    });
  });

  it('does not ask about a sale that is over', () => {
    expect(() => check(onSale({ saleEndsAt: behind() }), { price: 25 })).not.toThrow();
  });

  it.each([
    ['to the sale price', 15],
    ['below it', 12],
  ])('refuses to keep a sale the price goes down %s', (_case, price) => {
    expect(thrownBy(() => check(onSale(), { price, ...sale('keep') }))).toMatchObject({
      statusCode: 409,
      errorCode: 'PRODUCT_SALE_NOT_BELOW_PRICE',
      details: { salePrice: 15, price },
    });
  });

  it('keeps a sale above which the price stays', () => {
    expect(() => check(onSale(), { price: 25, ...sale('keep') })).not.toThrow();
  });

  it('takes the word to remove the sale, whatever the price', () => {
    expect(() => check(onSale(), { price: 10, ...sale('remove') })).not.toThrow();
  });

  it('counts a new sale from the new price', () => {
    expect(() => check(onSale(), { price: 30, ...sale('new', 25) })).not.toThrow();
  });

  it('refuses a new sale that does not fit the new price, naming it', () => {
    expect(thrownBy(() => check(variant(), { price: 4, ...sale('new', 5) }))).toMatchObject({
      statusCode: 400,
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { price: 4 },
    });
  });

  it('refuses a new sale on a variant out of sale and on a product that is deleted', () => {
    expect(
      thrownBy(() => check(variant({ deletedAt: new Date() }), { price: 5, ...sale('new', 1) })),
    ).toMatchObject({
      errorCode: 'VARIANT_NOT_FOUND',
    });
    expect(
      thrownBy(() => check(variant(), { price: 5, ...sale('new', 1) }, { deletedAt: new Date() })),
    ).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('lets the price of a variant out of sale change without a new sale', () => {
    expect(() => check(variant({ deletedAt: new Date() }), { price: 5 })).not.toThrow();
  });

  it('keeps the sizes all three or none', () => {
    expect(thrownBy(() => check(variant(), { weightGrams: 5, lengthMm: 10 }))).toMatchObject({
      statusCode: 400,
      errorCode: 'PRODUCT_SIZES_INCOMPLETE',
    });
  });

  it('clears what is known only when the admin says so', () => {
    const known = variant({ weightGrams: 300, lengthMm: 1, widthMm: 1, heightMm: 1 });

    expect(thrownBy(() => check(known, { weightGrams: null }))).toMatchObject({
      errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
    });
    expect(() => check(known, { weightGrams: null, withoutShippingData: true })).not.toThrow();
  });
});

describe('refusalOfVariants', () => {
  it('names every variant with its own code and details, under the status of the first', () => {
    const err = refusalOfVariants([
      { variantId: 4, err: new ConflictError('PRODUCT_SALE_DECISION_REQUIRED', { salePrice: 3 }) },
      { variantId: 9, err: new NotFoundError('VARIANT_NOT_FOUND') },
    ]);

    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      statusCode: 409,
      errorCode: 'VARIANTS_INVALID',
      details: {
        variants: [
          { variantId: 4, errorCode: 'PRODUCT_SALE_DECISION_REQUIRED', details: { salePrice: 3 } },
          { variantId: 9, errorCode: 'VARIANT_NOT_FOUND' },
        ],
      },
    });
    expect((err.details as { variants: object[] }).variants[1]).not.toHaveProperty('details');
  });

  it('takes the status of the first variant refused', () => {
    expect(
      refusalOfVariants([
        { variantId: 1, err: new NotFoundError('VARIANT_NOT_FOUND') },
        { variantId: 2, err: new BadRequestError('PRODUCT_PRICE_INVALID') },
      ]),
    ).toMatchObject({ statusCode: 404 });
  });
});

describe('checkEveryVariant', () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it('gives the result of each item in its order when none is refused', async () => {
    expect(
      await checkEveryVariant(
        items,
        (item) => item.id,
        (item) => item.id * 10,
      ),
    ).toEqual([10, 20, 30]);
  });

  it('checks every item and names all that are refused', async () => {
    const err = await rejectedBy(() =>
      checkEveryVariant(
        items,
        (item) => item.id,
        (item) => {
          if (item.id === 2) throw new BadRequestError('PRODUCT_PRICE_INVALID');
          if (item.id === 3) throw new NotFoundError('VARIANT_NOT_FOUND');
          return item.id;
        },
      ),
    );

    expect(err).toMatchObject({
      statusCode: 400,
      errorCode: 'VARIANTS_INVALID',
      details: {
        variants: [
          { variantId: 2, errorCode: 'PRODUCT_PRICE_INVALID' },
          { variantId: 3, errorCode: 'VARIANT_NOT_FOUND' },
        ],
      },
    });
  });

  it('lets a failure that is no refusal of the app through as it is', async () => {
    const boom = new Error('boom');

    expect(
      await rejectedBy(() =>
        checkEveryVariant(
          items,
          (item) => item.id,
          () => {
            throw boom;
          },
        ),
      ),
    ).toBe(boom);
  });

  it('waits for a check that answers later', async () => {
    expect(
      await checkEveryVariant(
        items,
        (item) => item.id,
        async (item) => item.id + 1,
      ),
    ).toEqual([2, 3, 4]);
  });
});

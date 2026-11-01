import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  isVariantVisible,
  mainVariantOf,
  variantFullOf,
  variantShortOf,
  type VariantRow,
} from '@routes/api/products/services/helpers/variant.helper.js';

const imageUrl = 'https://res.cloudinary.com/demo/image/upload/v1/products/1/a.jpg';
const otherUrl = 'https://res.cloudinary.com/demo/image/upload/v1/products/1/b.jpg';

const row = (patch: Partial<VariantRow> = {}): VariantRow => ({
  id: 31,
  productId: 1,
  position: 1,
  sku: 'DL-1',
  barcode: '4006381333931',
  price: new Prisma.Decimal('25.50'),
  stock: 10,
  reservedStock: 3,
  weightGrams: 350,
  lengthMm: 200,
  widthMm: 100,
  heightMm: 50,
  salePrice: null,
  saleEndsAt: null,
  salePriorPrice: null,
  deletedAt: null,
  updatedAt: new Date('2026-01-05T10:00:00.000Z'),
  images: [
    { position: 1, image: { id: 5, url: imageUrl } },
    { position: 2, image: { id: 6, url: otherUrl } },
  ],
  ...patch,
});

// the name and the values of the variant come from cartlify.variant_names, read with the context
const noContext = {
  expired: new Map<number, number>(),
  costs: new Map<number, unknown>(),
  names: new Map([
    [
      31,
      { name: 'Desk lamp', values: [] as { attributeId: number; name: string; value: string }[] },
    ],
  ]),
  attributes: new Map(),
};

describe('isVariantVisible', () => {
  it('is for sale and shows a picture', () => {
    expect(isVariantVisible(row())).toBe(true);
    expect(isVariantVisible(row({ images: [] }))).toBe(false);
    expect(isVariantVisible(row({ deletedAt: new Date() }))).toBe(false);
  });
});

describe('variantShortOf', () => {
  it('gives the price, the free units and the first picture in three sizes', () => {
    const out = variantShortOf(row(), noContext, 'buyer');

    expect(out).toMatchObject({
      id: 31,
      position: 1,
      name: 'Desk lamp',
      values: [],
      price: 25.5,
      // the stock less what the waiting orders hold
      stock: 7,
    });
    expect(Object.keys(out.image!)).toEqual(['url200', 'url400', 'url800']);
    expect(out.image!.url200).toContain('/upload/');
  });

  it('leaves out the units that are over and never shows a negative stock', () => {
    expect(
      variantShortOf(row(), { ...noContext, expired: new Map([[31, 4]]) }, 'buyer').stock,
    ).toBe(3);
    expect(
      variantShortOf(row(), { ...noContext, expired: new Map([[31, 9]]) }, 'buyer').stock,
    ).toBe(0);
    expect(variantShortOf(row({ stock: 2, reservedStock: 5 }), noContext, 'buyer').stock).toBe(0);
  });

  it('shows no picture for a variant without one', () => {
    expect(variantShortOf(row({ images: [] }), noContext, 'admin').image).toBeNull();
  });

  // the price stays the usual one, the sale goes next to it while it lasts
  it('shows the sale next to the price while it lasts, a buyer a sale that is over not', () => {
    const lasting = row({
      salePrice: new Prisma.Decimal('19.90'),
      saleEndsAt: new Date(Date.now() + 60_000),
      salePriorPrice: new Prisma.Decimal('22.00'),
    });
    const over = row({
      salePrice: new Prisma.Decimal('19.90'),
      saleEndsAt: new Date(Date.now() - 1),
      salePriorPrice: new Prisma.Decimal('22.00'),
    });

    expect(variantShortOf(lasting, noContext, 'buyer')).toMatchObject({
      price: 25.5,
      salePrice: 19.9,
      saleEndsAt: lasting.saleEndsAt!.toISOString(),
      salePriorPrice: 22,
    });
    for (const out of [
      variantShortOf(over, noContext, 'buyer'),
      variantShortOf(row(), noContext, 'buyer'),
    ]) {
      expect(out).not.toHaveProperty('salePrice');
      expect(out).not.toHaveProperty('saleEndsAt');
      expect(out).not.toHaveProperty('salePriorPrice');
    }
  });

  it('gives an admin the sale as the row keeps it: a sale that is over too, null without one', () => {
    const over = row({
      salePrice: new Prisma.Decimal('19.90'),
      saleEndsAt: new Date('2026-01-10T00:00:00.000Z'),
    });

    expect(variantShortOf(over, noContext, 'admin')).toMatchObject({
      salePrice: 19.9,
      saleEndsAt: '2026-01-10T00:00:00.000Z',
      salePriorPrice: null,
    });
    expect(variantShortOf(row(), noContext, 'admin')).toMatchObject({
      salePrice: null,
      saleEndsAt: null,
      salePriorPrice: null,
    });
  });

  it('shows a buyer neither whether the variant is visible nor when it was taken out', () => {
    const out = variantShortOf(row({ deletedAt: new Date() }), noContext, 'buyer');

    expect(out).not.toHaveProperty('visible');
    expect(out).not.toHaveProperty('deletedAt');
  });

  it('shows an admin whether a buyer sees the variant and when it was taken out of sale', () => {
    const deletedAt = new Date('2026-02-01T00:00:00.000Z');

    expect(variantShortOf(row(), noContext, 'admin')).toMatchObject({
      visible: true,
      deletedAt: null,
    });
    expect(variantShortOf(row({ deletedAt }), noContext, 'admin')).toMatchObject({
      visible: false,
      deletedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(variantShortOf(row({ images: [] }), noContext, 'admin')).toMatchObject({
      visible: false,
    });
  });
});

describe('variantFullOf', () => {
  it('adds the article number, the weight, the sizes and every picture by its place', () => {
    const out = variantFullOf(row(), noContext, 'buyer');

    expect(out).toMatchObject({
      sku: 'DL-1',
      weightGrams: 350,
      lengthMm: 200,
      widthMm: 100,
      heightMm: 50,
    });
    expect(out.images.map((image) => [image.id, image.position])).toEqual([
      [5, 1],
      [6, 2],
    ]);
    expect(Object.keys(out.images[0]!).sort()).toEqual(
      ['id', 'position', 'url200', 'url400', 'url800'].sort(),
    );
  });

  it('shows the weight and the sizes as null where they are not known', () => {
    const out = variantFullOf(
      row({ weightGrams: null, lengthMm: null, widthMm: null, heightMm: null, sku: null }),
      noContext,
      'buyer',
    );

    expect(out).toMatchObject({
      sku: null,
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
  });

  it('shows a buyer nothing of the stock counters, the barcode or the cost', () => {
    const out = variantFullOf(row(), noContext, 'buyer');

    for (const field of [
      'barcode',
      'totalStock',
      'reservedStock',
      'expiredStock',
      'lastUnitCost',
      'updatedAt',
    ]) {
      expect(out).not.toHaveProperty(field);
    }
  });

  it('shows an admin the whole stock, the reserve, the units that are over, the cost and the barcode', () => {
    const out = variantFullOf(
      row(),
      {
        ...noContext,
        expired: new Map([[31, 4]]),
        costs: new Map([[31, new Prisma.Decimal('12.30')]]),
      },
      'admin',
    );

    expect(out).toMatchObject({
      stock: 3,
      totalStock: 10,
      reservedStock: 3,
      expiredStock: 4,
      lastUnitCost: 12.3,
      barcode: '4006381333931',
      updatedAt: '2026-01-05T10:00:00.000Z',
    });
  });

  it('shows an admin a cost of null for a variant no supplier delivered, a barcode of null without one', () => {
    expect(variantFullOf(row({ barcode: null }), noContext, 'admin')).toMatchObject({
      lastUnitCost: null,
      expiredStock: 0,
      barcode: null,
    });
  });
});

describe('the name and the values of a variant', () => {
  const named = {
    ...noContext,
    names: new Map([
      [
        31,
        {
          name: 'Desk lamp — black, 12 W',
          values: [
            { attributeId: 4, name: 'Colour', value: 'black' },
            { attributeId: 9, name: 'Power', value: '12 W' },
          ],
        },
      ],
    ]),
  };

  it('are the ones the database wrote for it, in the short and in the full form', () => {
    for (const out of [
      variantShortOf(row(), named, 'buyer'),
      variantFullOf(row(), named, 'buyer'),
    ]) {
      expect(out.name).toBe('Desk lamp — black, 12 W');
      expect(out.values).toEqual([
        { attributeId: 4, name: 'Colour', value: 'black' },
        { attributeId: 9, name: 'Power', value: '12 W' },
      ]);
    }
  });

  it('are required: a variant the context has no name of is a server error', () => {
    expect(() => variantShortOf(row({ id: 99 }), named, 'buyer')).toThrow();
  });

  it('come with the characteristics of the card in the full form only', () => {
    const card = [
      {
        group: { id: 1, name: 'General', position: 1 },
        items: [
          {
            attribute: { id: 4, name: 'Colour', unit: null, type: 'option' as const, isMain: true },
            value: 'black',
            raw: 14,
            colorCode: '#000000',
          },
        ],
      },
    ];
    const withCard = { ...named, attributes: new Map([[31, card]]) };

    expect(variantFullOf(row(), withCard, 'buyer').attributes).toEqual(card);
    expect(variantFullOf(row(), named, 'buyer').attributes).toEqual([]);
    expect(variantShortOf(row(), withCard, 'buyer')).not.toHaveProperty('attributes');
  });
});

describe('mainVariantOf', () => {
  const rows = [
    { id: 1, stock: 0, reservedStock: 0 },
    { id: 2, stock: 5, reservedStock: 5 },
    { id: 3, stock: 5, reservedStock: 1 },
    { id: 4, stock: 9, reservedStock: 0 },
  ];

  it('is the first by its place that has free units', () => {
    expect(mainVariantOf(rows, noContext)?.id).toBe(3);
  });

  it('does not count the units that are over as free', () => {
    expect(mainVariantOf(rows, { expired: new Map([[3, 4]]) })?.id).toBe(4);
  });

  it('is the first of all when none has free units', () => {
    expect(mainVariantOf(rows.slice(0, 2), noContext)?.id).toBe(1);
  });

  it('is nothing for no variants', () => {
    expect(mainVariantOf([], noContext)).toBeUndefined();
  });
});

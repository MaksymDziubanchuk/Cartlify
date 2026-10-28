import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  mapProductRowToResponse,
  productViewOf,
} from '@routes/api/products/services/helpers/productMapper.helper.js';

const imageUrl = 'https://res.cloudinary.com/demo/image/upload/v1/products/1/0.jpg';

const product = {
  id: 1,
  name: 'Desk lamp',
  description: 'Warm light' as string | null,
  sku: 'DL-1' as string | null,
  price: new Prisma.Decimal('25.50'),
  salePrice: null as unknown,
  saleEndsAt: null as Date | null,
  salePriorPrice: null as unknown,
  stock: 10,
  reservedStock: 3,
  expiredStock: 0,
  category: { id: 2, name: 'Lamps', slug: 'lamps' },
  views: 40,
  popularity: 7,
  weightGrams: null as number | null,
  lengthMm: null as number | null,
  widthMm: null as number | null,
  heightMm: null as number | null,
  popularityOverride: null as number | null,
  popularityOverrideUntil: null as Date | null,
  avgRating: new Prisma.Decimal('4.25') as unknown,
  reviewsCount: 4,
  deletedAt: null as Date | null,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-05T10:00:00.000Z'),
};

const map = (patch: Partial<typeof product> = {}, view: 'buyer' | 'admin' = 'buyer') =>
  mapProductRowToResponse({
    product: { ...product, ...patch },
    images: [{ url: imageUrl, position: 0 }],
    categoryPath: [{ id: 1 as never, name: 'Home', slug: 'home' }],
    view,
  });

// the card of a product page: a buyer sees what helps to buy it, an admin sees the counters, the
// whole stock and the override of the popularity on top
describe('productViewOf', () => {
  it.each([
    ['GUEST', 'buyer'],
    ['USER', 'buyer'],
    ['ADMIN', 'admin'],
    ['ROOT', 'admin'],
  ] as const)('gives %s the card of a %s', (role, view) => {
    expect(productViewOf(role)).toBe(view);
  });
});

describe('mapProductRowToResponse', () => {
  it('turns decimals into numbers and dates into iso strings', () => {
    expect(map()).toMatchObject({
      id: 1,
      name: 'Desk lamp',
      description: 'Warm light',
      price: 25.5,
      avgRating: 4.25,
      createdAt: '2026-01-01T10:00:00.000Z',
    });
  });

  it('shows only the units that are not reserved by orders', () => {
    expect(map().stock).toBe(7);
  });

  // the units of batches whose last good day is over are not sold
  it('leaves the units that are over out of the free units, and shows them to an admin', () => {
    expect(map({ expiredStock: 4 }).stock).toBe(3);
    expect(map({ expiredStock: 4 }, 'admin')).toMatchObject({
      stock: 3,
      totalStock: 10,
      reservedStock: 3,
      expiredStock: 4,
    });
    expect(map({ expiredStock: 9 }).stock).toBe(0);
    expect(map({ expiredStock: 4 })).not.toHaveProperty('expiredStock');
  });

  it('never shows a negative stock, even if reservations exceed it', () => {
    expect(map({ stock: 2, reservedStock: 5 }).stock).toBe(0);
  });

  // what the product weighs and measures packed: the card of every role has it, null while unknown
  it('shows the weight and the sizes on the card of a buyer and of an admin, null where unknown', () => {
    const known = { weightGrams: 350, lengthMm: 200, widthMm: 100, heightMm: 50 };

    for (const view of ['buyer', 'admin'] as const) {
      expect(map(known, view)).toMatchObject(known);
      expect(map({}, view)).toMatchObject({
        weightGrams: null,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
      });
    }
  });

  // the card names the way to its category from the top of the tree
  it('names the category of the product and the way to it', () => {
    expect(map().category).toEqual({
      id: 2,
      name: 'Lamps',
      slug: 'lamps',
      path: [{ id: 1, name: 'Home', slug: 'home' }],
    });
    expect(map()).not.toHaveProperty('categoryId');
  });

  it('gives each image its sized urls', () => {
    const [image] = map().images;

    expect(Object.keys(image!)).toEqual(['url200', 'url400', 'url800']);
  });

  it('leaves out an empty description', () => {
    expect(map({ description: null })).not.toHaveProperty('description');
  });

  it('shows a product without reviews with a zero rating', () => {
    expect(map({ avgRating: null, reviewsCount: 0 }).avgRating).toBe(0);
  });

  // the price stays the usual one, the sale goes next to it while it lasts
  it('shows the sale next to the price while it lasts', () => {
    const saleEndsAt = new Date(Date.now() + 60_000);

    expect(map({ salePrice: new Prisma.Decimal('19.90'), saleEndsAt })).toMatchObject({
      price: 25.5,
      salePrice: 19.9,
      saleEndsAt: saleEndsAt.toISOString(),
    });
  });

  it('leaves out a sale past its end and a product without one', () => {
    const over = map({
      salePrice: new Prisma.Decimal('19.90'),
      saleEndsAt: new Date(Date.now() - 1),
      salePriorPrice: new Prisma.Decimal('25.50'),
    });

    for (const out of [over, map()]) {
      expect(out).not.toHaveProperty('salePrice');
      expect(out).not.toHaveProperty('saleEndsAt');
      expect(out).not.toHaveProperty('salePriorPrice');
    }
  });

  // the price a reduction is compared with; a sale from before it was written has none
  it('shows the lowest price of the 30 days before a sale next to it', () => {
    const saleEndsAt = new Date(Date.now() + 60_000);
    const sale = { salePrice: new Prisma.Decimal('19.90'), saleEndsAt };

    expect(map({ ...sale, salePriorPrice: new Prisma.Decimal('22.00') })).toMatchObject({
      salePriorPrice: 22,
    });
    expect(map(sale)).not.toHaveProperty('salePriorPrice');
    expect(map({ ...sale, salePriorPrice: new Prisma.Decimal('22.00') }, 'admin')).toMatchObject({
      salePriorPrice: 22,
    });
    expect(map({}, 'admin')).toMatchObject({ salePriorPrice: null });
  });

  // the description keeps its text and the safety data; the card gives them apart
  it('gives the text of the description and the safety data apart', () => {
    const safety = {
      manufacturer: { name: 'Lampwerk', address: 'Berlin', email: 'a@b.de', country: 'DE' },
      responsiblePerson: null,
      warnings: 'Hot.',
    };

    expect(
      map({ description: JSON.stringify({ v: 1, text: 'Warm light', safety }) }),
    ).toMatchObject({ description: 'Warm light', safety });
    expect(map({ description: 'Plain text' })).toMatchObject({
      description: 'Plain text',
      safety: null,
    });
    expect(map({ description: JSON.stringify({ v: 1, text: null, safety }) })).not.toHaveProperty(
      'description',
    );
  });

  // the list shows a buyer the popularity it sorts by, the card does not
  it('shows a buyer neither the popularity nor anything of the admin', () => {
    const out = map({ deletedAt: new Date('2026-02-01T00:00:00.000Z') });

    for (const field of [
      'popularity',
      'views',
      'updatedAt',
      'totalStock',
      'reservedStock',
      'popularityOverride',
      'popularityOverrideUntil',
      'deletedAt',
    ]) {
      expect(out).not.toHaveProperty(field);
    }
  });

  it('shows an admin the counters, the whole stock, the override and the delete date', () => {
    const out = map(
      {
        popularityOverride: 500,
        popularityOverrideUntil: new Date('2026-03-01T00:00:00.000Z'),
        deletedAt: new Date('2026-02-01T00:00:00.000Z'),
      },
      'admin',
    );

    expect(out).toMatchObject({
      stock: 7,
      totalStock: 10,
      reservedStock: 3,
      popularity: 7,
      views: 40,
      updatedAt: '2026-01-05T10:00:00.000Z',
      popularityOverride: 500,
      popularityOverrideUntil: '2026-03-01T00:00:00.000Z',
      deletedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  // an empty field of an admin is null, so every field is there
  it('shows an admin an empty override, sale and delete date as null', () => {
    expect(map({}, 'admin')).toMatchObject({
      popularityOverride: null,
      popularityOverrideUntil: null,
      salePrice: null,
      saleEndsAt: null,
      deletedAt: null,
    });
  });

  // an admin sees the row as it is: a sale and an override past their end too
  it('shows an admin a sale and an override past their end', () => {
    const out = map(
      {
        salePrice: new Prisma.Decimal('19.90'),
        saleEndsAt: new Date('2026-01-10T00:00:00.000Z'),
        popularityOverride: 70,
        popularityOverrideUntil: new Date('2026-01-10T00:00:00.000Z'),
      },
      'admin',
    );

    expect(out).toMatchObject({
      salePrice: 19.9,
      saleEndsAt: '2026-01-10T00:00:00.000Z',
      popularityOverride: 70,
      popularityOverrideUntil: '2026-01-10T00:00:00.000Z',
    });
  });
});

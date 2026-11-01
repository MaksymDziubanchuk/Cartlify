import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  mapGallery,
  mapProductCard,
  mapProductPart,
  productViewOf,
  type ProductResponseRow,
} from '@routes/api/products/services/helpers/productMapper.helper.js';

const imageUrl = 'https://res.cloudinary.com/demo/image/upload/v1/products/1/0.jpg';

const product: ProductResponseRow = {
  id: 1,
  name: 'Desk lamp',
  description: 'Warm light',
  category: { id: 2, name: 'Lamps', slug: 'lamps' },
  views: 40,
  popularity: 7,
  popularityOverride: null,
  popularityOverrideUntil: null,
  avgRating: new Prisma.Decimal('4.25'),
  reviewsCount: 4,
  manufacturerId: 7,
  euResponsibleId: null,
  warnings: null,
  deletedAt: null,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-05T10:00:00.000Z'),
};

// the parties of the directory a card gives: read apart by the ids of the row
const manufacturer = {
  id: 7,
  name: 'Lampwerk',
  address: 'Berlin',
  email: 'a@b.de',
  country: 'DE',
};
let euResponsible: typeof manufacturer | null = null;

const documents = [
  { id: 3, title: 'Manual', kind: 'instruction' as const, url: 'https://x/m.pdf' },
];

const map = (patch: Partial<ProductResponseRow> = {}, view: 'buyer' | 'admin' = 'buyer') =>
  mapProductCard({
    product: { ...product, ...patch },
    categoryPath: [{ id: 1 as never, name: 'Home', slug: 'home' }],
    extras: { manufacturer, euResponsible, documents },
    view,
  });

// the product of a card: a buyer sees what helps to buy it, an admin sees the counters and the
// override of the popularity on top. The price, the stock and the picture are the variant's
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

describe('mapProductCard', () => {
  it('turns decimals into numbers and dates into iso strings', () => {
    expect(map()).toMatchObject({
      id: 1,
      name: 'Desk lamp',
      description: 'Warm light',
      avgRating: 4.25,
      reviewsCount: 4,
      createdAt: '2026-01-01T10:00:00.000Z',
    });
  });

  // the variant carries these now
  it('has no price, no stock, no sale, no weight and no pictures of its own', () => {
    for (const view of ['buyer', 'admin'] as const) {
      const out = map({}, view);

      for (const field of [
        'price',
        'sku',
        'stock',
        'totalStock',
        'reservedStock',
        'expiredStock',
        'lastUnitCost',
        'salePrice',
        'saleEndsAt',
        'salePriorPrice',
        'weightGrams',
        'lengthMm',
        'widthMm',
        'heightMm',
        'images',
      ]) {
        expect(out).not.toHaveProperty(field);
      }
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

  it('leaves out an empty description', () => {
    expect(map({ description: null })).not.toHaveProperty('description');
  });

  it('shows a product without reviews with a zero rating', () => {
    expect(map({ avgRating: null, reviewsCount: 0 }).avgRating).toBe(0);
  });

  // the description is plain text; the manufacturer, the person in the EU, the warnings and the
  // documents come apart from it
  it('gives the text of the description, and the parties, the warnings and the documents apart', () => {
    euResponsible = { ...manufacturer, id: 8, name: 'EU Rep', country: 'CZ' };

    try {
      expect(map({ warnings: 'Hot.', euResponsibleId: 8 })).toMatchObject({
        description: 'Warm light',
        manufacturer,
        euResponsible,
        warnings: 'Hot.',
        documents,
      });
    } finally {
      euResponsible = null;
    }
    expect(map({})).toMatchObject({ manufacturer, euResponsible: null, warnings: null });
  });

  // the list shows a buyer the popularity it sorts by, the card does not
  it('shows a buyer neither the popularity nor anything of the admin', () => {
    const out = map({ deletedAt: new Date('2026-02-01T00:00:00.000Z') });

    for (const field of [
      'popularity',
      'views',
      'updatedAt',
      'popularityOverride',
      'popularityOverrideUntil',
      'deletedAt',
      'gallery',
    ]) {
      expect(out).not.toHaveProperty(field);
    }
  });

  it('shows an admin the counters, the override, the delete date and the gallery', () => {
    const gallery = mapGallery(
      [
        { id: 5, url: imageUrl, position: 0 },
        { id: 6, url: imageUrl, position: 1 },
      ],
      new Map([[5, [31, 32]]]),
    );

    const out = mapProductCard({
      product: {
        ...product,
        popularityOverride: 500,
        popularityOverrideUntil: new Date('2026-03-01T00:00:00.000Z'),
        deletedAt: new Date('2026-02-01T00:00:00.000Z'),
      },
      categoryPath: [],
      extras: { manufacturer, euResponsible: null, documents: [] },
      gallery,
      view: 'admin',
    });

    expect(out).toMatchObject({
      popularity: 7,
      views: 40,
      updatedAt: '2026-01-05T10:00:00.000Z',
      popularityOverride: 500,
      popularityOverrideUntil: '2026-03-01T00:00:00.000Z',
      deletedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(out.gallery).toEqual([
      expect.objectContaining({ id: 5, position: 0, variantIds: [31, 32] }),
      expect.objectContaining({ id: 6, position: 1, variantIds: [] }),
    ]);
  });

  // an empty field of an admin is null, so every field is there
  it('shows an admin an empty override and delete date as null, and an empty gallery as a list', () => {
    expect(map({}, 'admin')).toMatchObject({
      popularityOverride: null,
      popularityOverrideUntil: null,
      deletedAt: null,
      gallery: [],
    });
  });

  // an admin sees the row as it is: an override past its end too
  it('shows an admin an override past its end', () => {
    const out = map(
      {
        popularityOverride: 70,
        popularityOverrideUntil: new Date('2026-01-10T00:00:00.000Z'),
      },
      'admin',
    );

    expect(out).toMatchObject({
      popularityOverride: 70,
      popularityOverrideUntil: '2026-01-10T00:00:00.000Z',
    });
  });
});

// the product of a row of an answer that names a variant: the card adds its own fields to this
describe('mapProductPart', () => {
  it('gives a buyer the fields that help to buy, and an admin the counters on top', () => {
    const buyer = mapProductPart(product, 'buyer');

    expect(buyer).toEqual({
      id: 1,
      name: 'Desk lamp',
      description: 'Warm light',
      category: { id: 2, name: 'Lamps', slug: 'lamps' },
      avgRating: 4.25,
      reviewsCount: 4,
      createdAt: '2026-01-01T10:00:00.000Z',
    });
    expect(mapProductPart(product, 'admin')).toEqual({
      ...buyer,
      popularity: 7,
      views: 40,
      updatedAt: '2026-01-05T10:00:00.000Z',
      popularityOverride: null,
      popularityOverrideUntil: null,
      deletedAt: null,
    });
  });
});

describe('mapGallery', () => {
  it('gives each picture its sized urls, its place and the variants that show it', () => {
    const [first] = mapGallery([{ id: 5, url: imageUrl, position: 2 }], new Map());

    expect(Object.keys(first!).sort()).toEqual(
      ['id', 'position', 'url200', 'url400', 'url800', 'variantIds'].sort(),
    );
    expect(first).toMatchObject({ id: 5, position: 2, variantIds: [] });
  });
});

import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { mapProductRowToResponse } from '@routes/api/products/services/helpers/productMapper.helper.js';

const imageUrl = 'https://res.cloudinary.com/demo/image/upload/v1/products/1/0.jpg';

const product = {
  id: 1,
  name: 'Desk lamp',
  description: 'Warm light' as string | null,
  price: new Prisma.Decimal('25.50'),
  stock: 10,
  reservedStock: 3,
  categoryId: 2,
  views: 40,
  popularity: 7,
  avgRating: new Prisma.Decimal('4.25') as unknown,
  reviewsCount: 4,
  deletedAt: null as Date | null,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-05T10:00:00.000Z'),
};

const map = (patch: Partial<typeof product> = {}) =>
  mapProductRowToResponse({
    product: { ...product, ...patch },
    images: [{ url: imageUrl, position: 0 }],
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
      updatedAt: '2026-01-05T10:00:00.000Z',
    });
  });

  it('shows only the units that are not reserved by orders', () => {
    expect(map().stock).toBe(7);
  });

  it('never shows a negative stock, even if reservations exceed it', () => {
    expect(map({ stock: 2, reservedStock: 5 }).stock).toBe(0);
  });

  it('gives each image its sized urls', () => {
    const [image] = map().images;

    expect(Object.keys(image!)).toEqual(['url200', 'url400', 'url800']);
  });

  it('leaves out an empty description and a missing delete date', () => {
    const out = map({ description: null });

    expect(out).not.toHaveProperty('description');
    expect(out).not.toHaveProperty('deletedAt');
  });

  it('shows the delete date of a deleted product', () => {
    expect(map({ deletedAt: new Date('2026-02-01T00:00:00.000Z') }).deletedAt).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });

  it('shows a product without reviews with a zero rating', () => {
    expect(map({ avgRating: null, reviewsCount: 0 }).avgRating).toBe(0);
  });
});

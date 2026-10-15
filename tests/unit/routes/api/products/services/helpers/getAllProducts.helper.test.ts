import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { mapProductListRowToResponse } from '@routes/api/products/services/helpers/getAllProducts.helper.js';

const imageUrl = 'https://res.cloudinary.com/demo/image/upload/v1/products/1/0.jpg';

const row = {
  id: 1,
  name: 'Desk lamp',
  description: 'Warm light' as string | null,
  price: new Prisma.Decimal('25.50') as unknown,
  stock: 10,
  reservedStock: 3,
  categoryId: 2,
  views: 40,
  popularity: 7,
  avgRating: new Prisma.Decimal('4.25') as unknown,
  reviewsCount: 4,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-01-05T10:00:00.000Z'),
  deletedAt: null as Date | null,
  images: [{ url: imageUrl, position: 0, isPrimary: true }],
};

const map = (patch: Partial<typeof row> = {}) => mapProductListRowToResponse({ ...row, ...patch });

describe('mapProductListRowToResponse', () => {
  it('turns decimals into numbers and dates into iso strings', () => {
    expect(map()).toMatchObject({
      id: 1,
      name: 'Desk lamp',
      price: 25.5,
      avgRating: 4.25,
      createdAt: '2026-01-01T10:00:00.000Z',
    });
  });

  it('shows only the units that are not reserved by orders', () => {
    expect(map().stock).toBe(7);
  });

  // the product card shows the same, a list and a card must not disagree
  it('never shows a negative stock, even if reservations exceed it', () => {
    expect(map({ stock: 2, reservedStock: 5 }).stock).toBe(0);
  });
});

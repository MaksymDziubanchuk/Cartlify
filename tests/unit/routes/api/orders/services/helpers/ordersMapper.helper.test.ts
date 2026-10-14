import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { mapOrderRowToResponse } from '@routes/api/orders/services/helpers/ordersMapper.helper.js';
import { InternalError } from '@utils/errors.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

const primaryUrl = 'https://res.cloudinary.com/demo/image/upload/v1/products/4/0.jpg';

const item = (patch: Record<string, unknown> = {}) => ({
  id: 31,
  productId: 4,
  quantity: 2,
  unitPrice: new Prisma.Decimal('9.99'),
  totalPrice: new Prisma.Decimal('19.98'),
  product: {
    id: 4,
    name: 'Mug',
    categoryId: 1,
    stock: 5,
    reservedStock: 2,
    deletedAt: null,
    // queries order images primary first
    images: [{ url: primaryUrl, position: 0, isPrimary: true }],
  },
  ...patch,
});

const row = (patch: Record<string, unknown> = {}) => ({
  id: 10,
  userId: 3,
  status: 'pending',
  confirmed: false,
  total: new Prisma.Decimal('19.98'),
  shippingAddress: null,
  note: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  items: [item()],
  ...patch,
});

type Row = Parameters<typeof mapOrderRowToResponse>[0];
const map = (patch: Record<string, unknown> = {}) => mapOrderRowToResponse(row(patch) as Row);

describe('mapOrderRowToResponse', () => {
  it('turns money decimals into numbers', () => {
    const out = map();

    expect(out.total).toBe(19.98);
    expect(out.items[0]).toMatchObject({ unitPrice: 9.99, totalPrice: 19.98, quantity: 2 });
  });

  it('gives the item id, which cart item routes take as itemId', () => {
    expect(map().items[0]).toMatchObject({ id: 31, productId: 4 });
  });

  it('shows the units of the product that are still free', () => {
    expect(map().items[0]?.product.availableStock).toBe(3);
  });

  it('never shows a negative free stock', () => {
    const out = map({
      items: [item({ product: { ...item().product, stock: 1, reservedStock: 4 } })],
    });

    expect(out.items[0]?.product.availableStock).toBe(0);
  });

  it('builds the product image urls from the primary image', () => {
    expect(map().items[0]?.product.images.url200).toContain('/upload/c_fit,w_200');
  });

  it('sends an empty shipping address instead of null and leaves out an empty note', () => {
    const out = map();

    expect(out.shippingAddress).toBe('');
    expect(out).not.toHaveProperty('note');
  });

  it('keeps a note when there is one', () => {
    expect(map({ note: 'leave at the door' }).note).toBe('leave at the door');
  });

  it('maps an empty cart', () => {
    expect(map({ items: [], total: new Prisma.Decimal(0) })).toMatchObject({ items: [], total: 0 });
  });

  it('throws an internal error when a product has no image, which every product must have', () => {
    const noImage = item({ product: { ...item().product, images: [] } });

    expect(thrownBy(() => map({ items: [noImage] }))).toBeInstanceOf(InternalError);
  });
});

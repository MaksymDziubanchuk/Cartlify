import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  mapOrderRowToResponse,
  orderResponseSelect,
} from '@routes/api/orders/services/helpers/ordersMapper.helper.js';

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
  reservationExpiresAt: null,
  total: new Prisma.Decimal('19.98'),
  shippingAddress: null,
  recipientFirstName: null,
  recipientLastName: null,
  recipientPhone: null,
  note: null,
  paidAt: null,
  cancelledAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  items: [item()],
  ...patch,
});

type Row = Parameters<typeof mapOrderRowToResponse>[0];
const map = (patch: Record<string, unknown> = {}, expired = new Map<number, number>()) =>
  mapOrderRowToResponse(row(patch) as Row, expired);

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

  // the units of batches whose last good day is over are not sold
  it('leaves the units that are over out of the free units of an item', () => {
    expect(map({}, new Map([[4, 2]])).items[0]?.product.availableStock).toBe(1);
    expect(map({}, new Map([[4, 9]])).items[0]?.product.availableStock).toBe(0);
    expect(map({}, new Map([[5, 2]])).items[0]?.product.availableStock).toBe(3);
  });

  it('never shows a negative free stock', () => {
    const out = map({
      items: [item({ product: { ...item().product, stock: 1, reservedStock: 4 } })],
    });

    expect(out.items[0]?.product.availableStock).toBe(0);
  });

  it('builds the product image urls from the primary image', () => {
    expect(map().items[0]?.product.images?.url200).toContain('/upload/c_fit,w_200');
  });

  it('sends an empty shipping address instead of null and leaves out an empty note', () => {
    const out = map();

    expect(out.shippingAddress).toBe('');
    expect(out).not.toHaveProperty('note');
  });

  it('keeps a note when there is one', () => {
    expect(map({ note: 'leave at the door' }).note).toBe('leave at the door');
  });

  it('gives the recipient and the end of the reservation of a waiting order', () => {
    const expiresAt = new Date('2026-01-01T00:15:00Z');

    const out = map({
      status: 'waiting',
      confirmed: true,
      reservationExpiresAt: expiresAt,
      shippingAddress: 'Main st 1, Kyiv',
      recipientFirstName: 'Anna',
      recipientLastName: 'Koval',
      recipientPhone: '+380501234567',
    });

    expect(out).toMatchObject({
      reservationExpiresAt: expiresAt,
      shippingAddress: 'Main st 1, Kyiv',
      recipientFirstName: 'Anna',
      recipientLastName: 'Koval',
      recipientPhone: '+380501234567',
    });
  });

  it('leaves out the recipient and the reservation end while the order has none', () => {
    const out = map();

    for (const field of [
      'reservationExpiresAt',
      'recipientFirstName',
      'recipientLastName',
      'recipientPhone',
    ]) {
      expect(out).not.toHaveProperty(field);
    }
  });

  it('gives the times of the payment and of the cancel of an order that has them', () => {
    const paidAt = new Date('2026-01-01T00:10:00Z');
    const cancelledAt = new Date('2026-01-02T08:00:00Z');

    expect(orderResponseSelect).toMatchObject({ paidAt: true, cancelledAt: true });
    expect(map({ status: 'cancelled', confirmed: true, paidAt, cancelledAt })).toMatchObject({
      paidAt,
      cancelledAt,
    });
  });

  it('leaves out the times of the payment and of the cancel while the order has none', () => {
    const out = map();

    expect(out).not.toHaveProperty('paidAt');
    expect(out).not.toHaveProperty('cancelledAt');
  });

  it('never reads or gives the payment id', () => {
    expect(orderResponseSelect).not.toHaveProperty('paymentId');
    expect(orderResponseSelect).not.toHaveProperty('paymentProvider');
    const mapped = map({ paymentProvider: 'stripe', paymentId: 'pi_secret' });
    expect(mapped).not.toHaveProperty('paymentId');
    expect(mapped).not.toHaveProperty('paymentProvider');
  });

  it('maps an empty cart', () => {
    expect(map({ items: [], total: new Prisma.Decimal(0) })).toMatchObject({ items: [], total: 0 });
  });

  // a product without an image opens by its id and goes into a cart: the item shows no images
  it('gives the product of an item without an image no images', () => {
    const noImage = item({ product: { ...item().product, images: [] } });

    expect(map({ items: [noImage] }).items[0]?.product.images).toBeNull();
  });
});

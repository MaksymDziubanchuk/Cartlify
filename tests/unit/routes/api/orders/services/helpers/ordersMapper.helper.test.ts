import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it } from '@jest/globals';

import {
  mapOrderRowToResponse,
  orderResponseSelect,
} from '@routes/api/orders/services/helpers/ordersMapper.helper.js';

import { resetDelivery, setDelivery } from '../../../../../../helpers/delivery.js';

afterEach(resetDelivery);

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
    weightGrams: null,
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
  delivery: null,
  shipments: [],
  paidAt: null,
  cancelledAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  items: [item()],
  ...patch,
});

// where and to whom an order goes, as the row of order_deliveries holds it
const delivery = (patch: Record<string, unknown> = {}) => ({
  method: 'manual',
  recipientFirstName: 'Anna',
  recipientLastName: 'Koval',
  recipientPhone: '+380501234567',
  country: 'UA',
  postalCode: '01001',
  city: 'Kyiv',
  street: 'Khreshchatyk',
  house: '1',
  apartment: null,
  note: null,
  price: new Prisma.Decimal('0'),
  ...patch,
});

// a send of the order, the way the row of order_shipments holds it
const send = (patch: Record<string, unknown> = {}) => ({
  id: 1,
  carrier: 'DHL',
  trackingNumber: 'JD0146',
  trackingUrl: 'https://dhl.example.com/JD0146',
  cost: new Prisma.Decimal('7.35'),
  expense: true,
  shippedAt: new Date('2026-01-02T08:00:00Z'),
  rolledBackAt: null,
  ...patch,
});

type Row = Parameters<typeof mapOrderRowToResponse>[0];
const map = (patch: Record<string, unknown> = {}, expired = new Map<number, number>()) =>
  mapOrderRowToResponse(row(patch) as unknown as Row, expired);
const mapFor = (view: 'buyer' | 'admin', patch: Record<string, unknown> = {}) =>
  mapOrderRowToResponse(row(patch) as unknown as Row, new Map(), view);

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

  it('gives no delivery while the order has none', () => {
    expect(map().delivery).toBeNull();
  });

  it('gives the delivery by hand with the recipient, the address and the note', () => {
    const out = map({
      status: 'waiting',
      confirmed: true,
      delivery: delivery({ apartment: '12', note: 'leave at the door' }),
    });

    expect(out.delivery).toEqual({
      method: 'manual',
      price: 0,
      recipient: { firstName: 'Anna', lastName: 'Koval', phone: '+380501234567' },
      address: {
        country: 'UA',
        postalCode: '01001',
        city: 'Kyiv',
        street: 'Khreshchatyk',
        house: '1',
        apartment: '12',
      },
      note: 'leave at the door',
      pickup: null,
      shipment: null,
    });
  });

  it('gives a pickup with the place and the hours of the shop, and no address', () => {
    setDelivery({
      DELIVERY_METHODS: ['manual', 'pickup'],
      PICKUP_ADDRESS: 'Lichtstrasse 4',
      PICKUP_HOURS: 'Mon-Fri',
    });

    const out = map({
      confirmed: true,
      delivery: delivery({
        method: 'pickup',
        country: null,
        postalCode: null,
        city: null,
        street: null,
        house: null,
      }),
    });

    expect(out.delivery).toMatchObject({
      method: 'pickup',
      address: null,
      pickup: { address: 'Lichtstrasse 4', hours: 'Mon-Fri' },
    });
  });

  // the price is fixed at the confirmation; before it the order shows the price of now
  it('shows the price the confirmation fixed, and before it the price of now', () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 5, DELIVERY_FREE_FROM: 50 });
    const fixed = delivery({ price: new Prisma.Decimal('3.50') });

    expect(map({ confirmed: true, delivery: fixed }).delivery?.price).toBe(3.5);
    // 19.98 of items: the delivery of now costs 5
    expect(map({ confirmed: false, delivery: fixed }).delivery?.price).toBe(5);
  });

  it('adds the delivery of now to the items of an order that is not confirmed', () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 5, DELIVERY_FREE_FROM: 50 });

    const out = map({ delivery: delivery() });

    expect(out.itemsTotal).toBe(19.98);
    expect(out.total).toBe(24.98);
  });

  it('gives the total the database holds for an order that is confirmed', () => {
    const out = map({
      status: 'waiting',
      confirmed: true,
      total: new Prisma.Decimal('24.98'),
      delivery: delivery({ price: new Prisma.Decimal('5.00') }),
    });

    expect(out.itemsTotal).toBe(19.98);
    expect(out.total).toBe(24.98);
  });

  it('gives what each method would cost to an order that is not confirmed, and not to one that is', () => {
    setDelivery({
      DELIVERY_METHODS: ['manual', 'pickup'],
      DELIVERY_FLAT_PRICE: 5,
      DELIVERY_FREE_FROM: 50,
    });

    // 19.98 of items: 30.02 short of the free delivery
    expect(map().deliveryQuotes).toEqual([
      { method: 'manual', price: 5, freeFrom: 50, remainingToFree: 30.02 },
      { method: 'pickup', price: 0, freeFrom: null, remainingToFree: null },
    ]);
    expect(map({ status: 'waiting', confirmed: true })).not.toHaveProperty('deliveryQuotes');
  });

  it('gives the end of the reservation of a waiting order, and leaves it out while there is none', () => {
    const expiresAt = new Date('2026-01-01T00:15:00Z');

    expect(
      map({ status: 'waiting', confirmed: true, reservationExpiresAt: expiresAt }),
    ).toMatchObject({
      reservationExpiresAt: expiresAt,
    });
    expect(map()).not.toHaveProperty('reservationExpiresAt');
  });

  // the buyer is told who carries the order once it is shipped, never what the shop pays for it
  it('gives the buyer the send on its way once the order is shipped, without its cost', () => {
    const shipped = map({
      status: 'shipped',
      confirmed: true,
      delivery: delivery(),
      shipments: [send()],
    });
    const paid = map({
      status: 'paid',
      confirmed: true,
      delivery: delivery(),
      shipments: [send()],
    });

    expect(shipped.delivery?.shipment).toEqual({
      carrier: 'DHL',
      trackingNumber: 'JD0146',
      trackingUrl: 'https://dhl.example.com/JD0146',
    });
    expect(paid.delivery?.shipment).toBeNull();
    expect(shipped).not.toHaveProperty('shipments');
    expect(JSON.stringify(shipped)).not.toContain('7.35');
  });

  it('gives the send that was not taken back, the latest one first in the row', () => {
    const out = map({
      status: 'shipped',
      confirmed: true,
      delivery: delivery(),
      shipments: [
        send({ id: 3, carrier: 'UPS', rolledBackAt: new Date('2026-01-03T00:00:00Z') }),
        send({ id: 2, carrier: 'DPD' }),
        send({ id: 1, carrier: 'DHL', rolledBackAt: new Date('2026-01-02T00:00:00Z') }),
      ],
    });

    expect(out.delivery?.shipment?.carrier).toBe('DPD');
  });

  it('gives a pickup no send', () => {
    const out = map({
      status: 'shipped',
      confirmed: true,
      delivery: delivery({ method: 'pickup' }),
      shipments: [send()],
    });

    expect(out.delivery?.shipment).toBeNull();
  });

  it('gives an admin every send with its cost, the weight of the order and whether it is whole', () => {
    const heavy = item({ product: { ...item().product, weightGrams: 350 }, quantity: 2 });
    const bare = item({ id: 32, productId: 5, product: { ...item().product, id: 5 } });
    const out = mapFor('admin', {
      status: 'shipped',
      confirmed: true,
      delivery: delivery(),
      shipments: [send({ id: 2 }), send({ id: 1, cost: null, expense: false })],
      items: [heavy, bare],
    });

    expect(out.shipments).toEqual([
      expect.objectContaining({ id: 2, cost: 7.35, expense: true, rolledBackAt: null }),
      expect.objectContaining({ id: 1, cost: null, expense: false }),
    ]);
    // the item without a weight is not counted, and the weight is not the whole one then
    expect(out.weight).toEqual({ grams: 700, complete: false });
  });

  it('gives the weight of an order whole when every item has one', () => {
    const heavy = item({ product: { ...item().product, weightGrams: 350 }, quantity: 2 });

    expect(mapFor('admin', { items: [heavy] }).weight).toEqual({ grams: 700, complete: true });
    expect(mapFor('buyer', { items: [heavy] })).not.toHaveProperty('weight');
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

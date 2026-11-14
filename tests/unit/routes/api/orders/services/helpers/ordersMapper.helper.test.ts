import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  mapOrderRowToResponse,
  orderResponseSelect,
} from '@routes/api/orders/services/helpers/ordersMapper.helper.js';

import { resetShopSettings, setShopSettings } from '../../../../../../helpers/shopSettings.js';

afterEach(resetShopSettings);

const primaryUrl = 'https://res.cloudinary.com/demo/image/upload/v1/products/4/0.jpg';

// a variant as variantRowSelect reads it: the pictures come by their place in the variant
const variantRow = (patch: Record<string, unknown> = {}) => ({
  id: 21,
  productId: 4,
  position: 2,
  sku: null,
  barcode: null,
  price: new Prisma.Decimal('9.99'),
  stock: 5,
  reservedStock: 2,
  weightGrams: null,
  lengthMm: null,
  widthMm: null,
  heightMm: null,
  salePrice: null,
  saleEndsAt: null,
  salePriorPrice: null,
  deletedAt: null,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  images: [{ position: 1, image: { id: 7, url: primaryUrl } }],
  ...patch,
});

const item = (patch: Record<string, unknown> = {}) => ({
  id: 31,
  productId: 4,
  variantId: 21,
  quantity: 2,
  unitPrice: new Prisma.Decimal('9.99'),
  totalPrice: new Prisma.Decimal('19.98'),
  productName: null,
  withdrawal: 'allowed',
  product: { id: 4, name: 'Mug', categoryId: 1, deletedAt: null },
  variant: variantRow(),
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
  deliveredAt: null,
  withdrawalDays: null,
  returnStatus: 'none',
  // what holds the order from its sending, and the warning of an order already sent
  holds: [],
  fraudWarnedAt: null,
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
  // what the send cost the shop, the sum of its lines in the money journal
  cost: 7.35,
  expense: true,
  shippedAt: new Date('2026-01-02T08:00:00Z'),
  rolledBackAt: null,
  ...patch,
});

type Row = Parameters<typeof mapOrderRowToResponse>[0];
// the name the variant has now comes with the context (cartlify.variant_names)
const names = new Map([[21, { name: 'Mug', values: [] }]]);
// the end of the period of withdrawal the database counted, by the id of the order
const noEnds = new Map<number, Date>();
// the rule of now of the products of the items of an order that is not confirmed, by product id
const noRules = new Map<number, 'allowed'>();
const map = (
  patch: Record<string, unknown> = {},
  expired = new Map<number, number>(),
  currentNames = names,
  withdrawalEnds = noEnds,
  rules: Map<number, never> = noRules as Map<number, never>,
) =>
  mapOrderRowToResponse(row(patch) as unknown as Row, {
    expired,
    names: currentNames,
    rules,
    withdrawalEnds,
    withdrawalDeadlines: withdrawalEnds,
    returns: new Map(),
    returnUnits: new Map(),
    withdrawals: new Map(),
    withdrawable: new Map(),
    money: new Map(),
  });
// the statements of the order 10 an admin is told of
const returns = new Map([
  [
    10,
    [
      {
        id: 4,
        code: 'R10-1',
        statedAt: '2026-01-05T10:00:00.000Z',
        source: 'admin' as const,
        basis: 'other' as const,
        reason: 'defect' as const,
        extendsId: null,
        closedAt: null,
      },
    ],
  ],
]);
// what the buyer of the order 10 sees of their statements, and the units they can still state
const withdrawals = new Map([
  [
    10,
    [
      {
        id: 4,
        code: 'W10-1',
        statedAt: '2026-01-02T09:00:00.000Z',
        source: 'account' as const,
        basis: 'withdrawal' as const,
        reason: null,
        step: 'received' as const,
        closedAt: null,
        parcels: [],
        refundedTotal: 0,
        refunds: [],
        items: [],
      },
    ],
  ],
]);
const withdrawable = new Map([[10, [{ orderItemId: 1, quantity: 2 }]]]);
// the money of the order 10 the money journal holds, short, the oldest first
const money = new Map([
  [
    10,
    [
      {
        id: 51,
        event: 'money.payment',
        purpose: 'order' as const,
        part: 'goods' as const,
        amount: 19.98,
        state: null,
        createdAt: '2026-01-01T00:10:00.000Z',
      },
    ],
  ],
]);
const mapFor = (view: 'buyer' | 'admin', patch: Record<string, unknown> = {}) =>
  mapOrderRowToResponse(
    row(patch) as unknown as Row,
    {
      expired: new Map(),
      names,
      rules: noRules,
      withdrawalEnds: noEnds,
      withdrawalDeadlines: noEnds,
      returns,
      returnUnits: new Map(),
      withdrawals,
      withdrawable,
      money,
    },
    view,
  );

describe('mapOrderRowToResponse', () => {
  it('turns money decimals into numbers', () => {
    const out = map();

    expect(out.total).toBe(19.98);
    expect(out.items[0]).toMatchObject({ unitPrice: 9.99, totalPrice: 19.98, quantity: 2 });
  });

  it('gives the item id, which cart item routes take as itemId, and the product and the variant', () => {
    expect(map().items[0]).toMatchObject({
      id: 31,
      product: { id: 4, name: 'Mug', categoryId: 1 },
      variant: { id: 21, position: 2 },
    });
    expect(map().items[0]).not.toHaveProperty('productId');
  });

  it('shows the units of the variant that are still free', () => {
    expect(map().items[0]?.variant.stock).toBe(3);
  });

  // the units of batches whose last good day is over are not sold; the units are those of the
  // variant, not of its product
  it('leaves the units that are over out of the free units of an item', () => {
    expect(map({}, new Map([[21, 2]])).items[0]?.variant.stock).toBe(1);
    expect(map({}, new Map([[21, 9]])).items[0]?.variant.stock).toBe(0);
    expect(map({}, new Map([[4, 2]])).items[0]?.variant.stock).toBe(3);
    expect(map({}, new Map([[22, 2]])).items[0]?.variant.stock).toBe(3);
  });

  it('never shows a negative free stock', () => {
    const out = map({
      items: [item({ variant: variantRow({ stock: 1, reservedStock: 4 }) })],
    });

    expect(out.items[0]?.variant.stock).toBe(0);
  });

  it('builds the image urls from the first picture of the variant', () => {
    expect(map().items[0]?.variant.image?.url200).toContain('/upload/c_fit,w_200');
  });

  it('takes the picture of the variant that has the lowest place, not one of another variant', () => {
    const second = 'https://res.cloudinary.com/demo/image/upload/v1/products/4/1.jpg';
    const out = map({
      items: [
        item({
          variant: variantRow({
            images: [
              { position: 1, image: { id: 8, url: second } },
              { position: 2, image: { id: 7, url: primaryUrl } },
            ],
          }),
        }),
      ],
    });

    expect(out.items[0]?.variant.image?.url800).toContain('/products/4/1.jpg');
  });

  // a cart and an order waiting for its payment show what the variant sells at now
  it('shows the price and the sale of the variant while the order is not paid', () => {
    const sale = {
      salePrice: new Prisma.Decimal('7.50'),
      saleEndsAt: new Date(Date.now() + 86_400_000),
      salePriorPrice: new Prisma.Decimal('9.00'),
    };
    const sells = item({ variant: variantRow(sale) });

    for (const status of ['pending', 'unconfirmed', 'waiting']) {
      const out = map({ status, confirmed: status === 'waiting', items: [sells] });

      expect(out.items[0]?.variant).toMatchObject({
        price: 9.99,
        salePrice: 7.5,
        salePriorPrice: 9,
        forSale: true,
      });
    }
  });

  // the order a buyer paid keeps what it was bought at: the copy of the price, no sale
  it('shows the copy of the price and no sale once the order is paid', () => {
    const sale = {
      salePrice: new Prisma.Decimal('7.50'),
      saleEndsAt: new Date(Date.now() + 86_400_000),
    };
    const bought = item({
      unitPrice: new Prisma.Decimal('8.00'),
      totalPrice: new Prisma.Decimal('16.00'),
      variant: variantRow({ price: new Prisma.Decimal('12.00'), ...sale }),
    });

    for (const status of ['paid', 'shipped', 'delivered', 'cancelled']) {
      const variant = map({ status, confirmed: true, items: [bought] }).items[0]?.variant;

      expect(variant).toMatchObject({ price: 8, forSale: true });
      expect(variant).not.toHaveProperty('salePrice');
    }
  });

  // the name of the confirmation is a copy, a cart follows the variant
  it('keeps the copy of the name once the order is confirmed and follows the variant before', () => {
    const named = item({ productName: 'Mug (old name)' });

    expect(map({ confirmed: true, status: 'waiting', items: [named] }).items[0]?.variant.name).toBe(
      'Mug (old name)',
    );
    expect(map({ confirmed: true, status: 'paid', items: [named] }).items[0]?.variant.name).toBe(
      'Mug (old name)',
    );
    expect(map({ items: [named] }).items[0]?.variant.name).toBe('Mug');
    // an item from before the names were kept shows the name of now
    expect(map({ confirmed: true, status: 'paid' }).items[0]?.variant.name).toBe('Mug');
    // the name of now is the one the database writes with the values that tell the variants apart
    const renamed = new Map([[21, { name: 'Mug — black', values: [] }]]);
    expect(map({ items: [named] }, new Map(), renamed).items[0]?.variant.name).toBe('Mug — black');
    expect(
      map({ confirmed: true, status: 'paid' }, new Map(), renamed).items[0]?.variant.name,
    ).toBe('Mug — black');
    expect(
      map({ confirmed: true, status: 'paid', items: [named] }, new Map(), renamed).items[0]?.variant
        .name,
    ).toBe('Mug (old name)');
  });

  // a variant a buyer does not see stays in an order that is confirmed and says it is not for sale
  it.each([
    ['taken out of sale', { variant: variantRow({ deletedAt: new Date() }) }],
    ['showing no picture', { variant: variantRow({ images: [] }) }],
    [
      'of a removed product',
      { product: { id: 4, name: 'Mug', categoryId: 1, deletedAt: new Date() } },
    ],
  ])('marks a variant %s as not for sale', (_case, patch) => {
    const out = map({ confirmed: true, status: 'paid', items: [item(patch)] });

    expect(out.items[0]?.variant.forSale).toBe(false);
    expect(
      map({ confirmed: true, status: 'paid', items: [item()] }).items[0]?.variant.forSale,
    ).toBe(true);
  });

  it('gives a variant that shows no picture a null image', () => {
    const out = map({ items: [item({ variant: variantRow({ images: [] }) })] });

    expect(out.items[0]?.variant.image).toBeNull();
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
    setShopSettings({
      deliveryMethods: ['manual', 'pickup'],
      pickupAddress: 'Lichtstrasse 4',
      pickupHours: 'Mon-Fri',
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
    setShopSettings({ deliveryFlatPrice: 5, deliveryFreeFrom: 50 });
    const fixed = delivery({ price: new Prisma.Decimal('3.50') });

    expect(map({ confirmed: true, delivery: fixed }).delivery?.price).toBe(3.5);
    // 19.98 of items: the delivery of now costs 5
    expect(map({ confirmed: false, delivery: fixed }).delivery?.price).toBe(5);
  });

  it('adds the delivery of now to the items of an order that is not confirmed', () => {
    setShopSettings({ deliveryFlatPrice: 5, deliveryFreeFrom: 50 });

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
    setShopSettings({
      deliveryMethods: ['manual', 'pickup'],
      deliveryFlatPrice: 5,
      deliveryFreeFrom: 50,
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
    const heavy = item({ variant: variantRow({ weightGrams: 350 }), quantity: 2 });
    const bare = item({ id: 32, variantId: 22, variant: variantRow({ id: 22 }) });
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
    const heavy = item({ variant: variantRow({ weightGrams: 350 }), quantity: 2 });

    expect(mapFor('admin', { items: [heavy] }).weight).toEqual({ grams: 700, complete: true });
    expect(mapFor('buyer', { items: [heavy] })).not.toHaveProperty('weight');
  });

  // the weight is the weight of each variant bought, times its units: two variants of one product
  // weigh what each weighs
  it('adds up the weights of the variants of one product, each times its units', () => {
    const light = item({ id: 31, variant: variantRow({ id: 21, weightGrams: 200 }), quantity: 3 });
    const heavy = item({
      id: 32,
      variantId: 22,
      variant: variantRow({ id: 22, weightGrams: 900 }),
      quantity: 1,
    });

    expect(mapFor('admin', { items: [light, heavy] }).weight).toEqual({
      grams: 1500,
      complete: true,
    });
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

  // orders.holds and orders.fraudWarnedAt, written by the database; the money of the order comes
  // with the context, from the money journal
  describe('what holds the order and its money', () => {
    const held = [
      { reason: 'payment_review', since: '2026-01-01T00:20:00.000Z', ref: 'prv_1' },
      { reason: 'dispute', since: '2026-01-01T00:30:00.000Z', ref: 7 },
    ];

    it('reads what holds the order and the warning of the provider', () => {
      expect(orderResponseSelect).toMatchObject({ holds: true, fraudWarnedAt: true });
    });

    it('gives an admin each hold as the database keeps it, with since and what put it', () => {
      expect(mapFor('admin', { status: 'paid', confirmed: true, holds: held }).holds).toEqual(held);
      expect(mapFor('admin').holds).toEqual([]);
    });

    it('gives an admin the time of the warning of an order already sent, and leaves it out while there is none', () => {
      const fraudWarnedAt = new Date('2026-01-03T09:00:00Z');

      expect(
        mapFor('admin', { status: 'shipped', confirmed: true, fraudWarnedAt }).fraudWarnedAt,
      ).toEqual(fraudWarnedAt);
      expect(mapFor('admin')).not.toHaveProperty('fraudWarnedAt');
    });

    it('gives an admin the money of the order, and an empty list to an order without money', () => {
      expect(mapFor('admin').money).toEqual(money.get(10));
      expect(mapFor('admin', { id: 99 }).money).toEqual([]);
    });

    it('gives the buyer none of it', () => {
      const out = mapFor('buyer', {
        status: 'shipped',
        confirmed: true,
        holds: held,
        fraudWarnedAt: new Date('2026-01-03T09:00:00Z'),
      });

      expect(out).not.toHaveProperty('holds');
      expect(out).not.toHaveProperty('fraudWarnedAt');
      expect(out).not.toHaveProperty('money');
    });
  });

  describe('the statements of return', () => {
    it('gives the state of the order as to its statements to everybody', () => {
      expect(orderResponseSelect).toMatchObject({ returnStatus: true });
      expect(map({ returnStatus: 'open' }).returnStatus).toBe('open');
      expect(mapFor('admin', { returnStatus: 'declined' }).returnStatus).toBe('declined');
    });

    it('lists the statements of the order for an admin only', () => {
      expect(mapFor('admin', { returnStatus: 'open' }).returns).toEqual(returns.get(10));
      expect(mapFor('buyer', { returnStatus: 'open' })).not.toHaveProperty('returns');
    });

    it('gives the buyer their statements and the units they can still state, never to an admin', () => {
      const buyer = mapFor('buyer', { returnStatus: 'open' });

      expect(buyer.withdrawals).toEqual(withdrawals.get(10));
      expect(buyer.withdrawable).toEqual(withdrawable.get(10));
      expect(mapFor('admin', { returnStatus: 'open' })).not.toHaveProperty('withdrawals');
      expect(mapFor('admin', { returnStatus: 'open' })).not.toHaveProperty('withdrawable');
    });

    it('gives the buyer empty lists for an order with no statements and nothing to state', () => {
      const out = mapFor('buyer', { id: 99 });

      expect(out.withdrawals).toEqual([]);
      expect(out.withdrawable).toEqual([]);
    });

    it('gives an admin an empty list for an order with no statements', () => {
      expect(mapFor('admin', { id: 99 }).returns).toEqual([]);
    });
  });

  describe('the rule of withdrawal of an item', () => {
    const rules = new Map([[4, 'sealed_hygiene' as never]]);

    it('reads the rule the item kept (db/05) and gives it with its kind', () => {
      expect(orderResponseSelect.items.select).toMatchObject({ withdrawal: true });
      expect(map({ confirmed: true, status: 'waiting' }).items[0]!.withdrawal).toEqual({
        rule: 'allowed',
        right: 'full',
      });
    });

    it('shows the rule of now in a cart, not the one the item has kept', () => {
      const out = map({}, undefined, undefined, undefined, rules);

      expect(out.items[0]!.withdrawal).toEqual({ rule: 'sealed_hygiene', right: 'conditional' });
    });

    it('keeps the rule of the confirmation once the order is confirmed, whatever is read of now', () => {
      const out = map(
        { confirmed: true, status: 'paid', items: [item({ withdrawal: 'perishable' })] },
        undefined,
        undefined,
        undefined,
        rules,
      );

      expect(out.items[0]!.withdrawal).toEqual({ rule: 'perishable', right: 'none' });
    });

    it('falls back to the rule the item kept when the cart has none of now', () => {
      const out = map({ items: [item({ withdrawal: 'periodical' })] });

      expect(out.items[0]!.withdrawal).toEqual({ rule: 'periodical', right: 'none' });
    });
  });

  describe('the withdrawal', () => {
    const deliveredAt = new Date('2026-03-03T15:00:00Z');
    const endsAt = new Date('2026-03-21T22:59:59.999Z');
    const ends = new Map([[10, endsAt]]);
    const delivered = { status: 'delivered', confirmed: true, deliveredAt };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('reads the time of the delivery and the days the order kept, and never their payer', () => {
      expect(orderResponseSelect).toMatchObject({ deliveredAt: true, withdrawalDays: true });
    });

    it('gives the time of the delivery and the end of the period of a delivered order', () => {
      jest.spyOn(Date, 'now').mockReturnValue(deliveredAt.getTime());

      expect(map(delivered, undefined, undefined, ends)).toMatchObject({
        deliveredAt,
        withdrawalEndsAt: endsAt,
        withdrawalOpen: true,
      });
    });

    it('leaves out both times until the order is delivered', () => {
      const out = map({ status: 'shipped', confirmed: true }, undefined, undefined, ends);

      expect(out).not.toHaveProperty('deliveredAt');
      expect(out).not.toHaveProperty('withdrawalEndsAt');
    });

    it('is open until the end of the period, the last millisecond included', () => {
      const now = jest.spyOn(Date, 'now');

      now.mockReturnValue(endsAt.getTime());
      expect(map(delivered, undefined, undefined, ends).withdrawalOpen).toBe(true);

      now.mockReturnValue(endsAt.getTime() + 1);
      expect(map(delivered, undefined, undefined, ends).withdrawalOpen).toBe(false);
    });

    it.each([
      ['paid', true],
      ['shipped', true],
      ['pending', false],
      ['unconfirmed', false],
      ['waiting', false],
      ['cancelled', false],
    ])('is %s open: %s (the period starts with the delivery)', (status, open) => {
      expect(map({ status, confirmed: status !== 'pending' }).withdrawalOpen).toBe(open);
    });

    it('is closed for a delivered order the database gave no end for', () => {
      expect(map(delivered).withdrawalOpen).toBe(false);
    });
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

  it('reads the variant of an item with its pictures, its price, its stock and its weight', () => {
    const items = (orderResponseSelect.items as { select: Record<string, unknown> }).select;

    expect(items).toMatchObject({ variantId: true, productName: true });
    expect(items.variant).toMatchObject({
      select: {
        price: true,
        stock: true,
        reservedStock: true,
        weightGrams: true,
        images: expect.anything(),
      },
    });
  });
});

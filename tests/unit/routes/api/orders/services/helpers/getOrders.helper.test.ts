import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import {
  buildOrdersCursorWhere,
  buildOrdersOrderBy,
  buildOrdersWhere,
  makeNextOrdersCursor,
  normalizeFindOrdersInput,
} from '@routes/api/orders/services/helpers/getOrders.helper.js';

import type { FindOrdersDto, OrdersSortBy, OrdersSortDir } from 'types/dto/orders.dto.js';

import { thrownBy } from '../../../../../../helpers/errors.js';
import { sortRows, walkPages } from '../../../../../../helpers/prismaWhere.js';

const dto = (patch: Partial<FindOrdersDto> = {}): FindOrdersDto =>
  ({ actorId: 3, actorRole: 'USER', ...patch }) as FindOrdersDto;

const at = (day: number) => new Date(`2026-03-${String(day).padStart(2, '0')}T10:00:00.000Z`);

// how an order goes: by hand to a city of a country (the price of the delivery with it), a pickup
// at the shop, or no delivery yet
type Delivery = {
  method: 'manual' | 'pickup';
  price: Prisma.Decimal;
  country: string | null;
  city: string | null;
};

const byHand = (country: string, city: string, price = '5.00'): Delivery => ({
  method: 'manual',
  price: new Prisma.Decimal(price),
  country,
  city,
});

const pickup: Delivery = {
  method: 'pickup',
  price: new Prisma.Decimal('0.00'),
  country: null,
  city: null,
};

const order = (
  id: number,
  userId: number,
  status: string,
  total: string,
  delivery: Delivery | null,
  createdDay: number,
  updatedDay: number,
  paidDay: number | null,
) => ({
  id,
  userId,
  status,
  total: new Prisma.Decimal(total),
  delivery,
  createdAt: at(createdDay),
  updatedAt: at(updatedDay),
  paidAt: paidDay === null ? null : at(paidDay),
});

// ties on every sort field, so the id has to break them; the carts (pending) are never listed,
// the orders that are not paid have no time of payment
const orders = [
  order(1, 3, 'paid', '10.00', byHand('UA', 'Kyiv'), 1, 1, 1),
  order(2, 3, 'unconfirmed', '25.50', null, 1, 2, null),
  order(3, 4, 'waiting', '10.00', byHand('UA', 'Lviv', '0.00'), 2, 2, null),
  order(4, 3, 'shipped', '99.99', byHand('UA', 'Kyiv'), 2, 2, 2),
  order(5, 4, 'delivered', '25.50', pickup, 2, 5, 2),
  order(6, 3, 'unconfirmed', '0.00', null, 5, 5, null),
  order(7, 5, 'cancelled', '10.00', byHand('PL', 'Warsaw', '9.50'), 6, 7, 6),
  order(8, 5, 'paid', '99.99', byHand('UA', 'Lviv'), 1, 1, 1),
  order(9, 3, 'paid', '25.50', pickup, 9, 9, 9),
  order(10, 3, 'pending', '25.50', byHand('UA', 'Kyiv'), 9, 9, null),
  order(11, 4, 'pending', '0.00', null, 3, 3, null),
];

const SORTS: OrdersSortBy[] = [
  'createdAt',
  'updatedAt',
  'total',
  'paidAt',
  'deliveryMethod',
  'destination',
  'deliveryPrice',
];
const DIRS: OrdersSortDir[] = ['asc', 'desc'];

describe('normalizeFindOrdersInput', () => {
  it('lists 20 orders, the newest first, when the query sets nothing', () => {
    expect(normalizeFindOrdersInput(dto())).toMatchObject({
      limit: 20,
      sortBy: 'createdAt',
      sortDir: 'desc',
      cursor: undefined,
      status: undefined,
      confirmed: undefined,
    });
  });

  it('caps the page size at 100', () => {
    expect(normalizeFindOrdersInput(dto({ limit: 500 })).limit).toBe(100);
  });

  it('rejects a page size below one', () => {
    expect(thrownBy(() => normalizeFindOrdersInput(dto({ limit: 0 })))).toMatchObject({
      statusCode: 400,
      errorCode: 'LIMIT_INVALID',
    });
  });

  it.each(['waiting', 'unconfirmed', 'paid', 'shipped', 'delivered', 'cancelled'])(
    'accepts the %s status filter',
    (status) => {
      expect(normalizeFindOrdersInput(dto({ status } as Partial<FindOrdersDto>)).status).toBe(
        status,
      );
    },
  );

  // the cart is not an order, GET /api/orders/current gives it
  it.each(['lost', 'pending'])('rejects the %s status', (status) => {
    const input = dto({ status } as unknown as Partial<FindOrdersDto>);

    expect(thrownBy(() => normalizeFindOrdersInput(input))).toMatchObject({
      statusCode: 400,
      errorCode: 'STATUS_INVALID',
    });
  });

  it('keeps the confirmed filter only when it is a boolean', () => {
    expect(normalizeFindOrdersInput(dto({ confirmed: false })).confirmed).toBe(false);
    expect(
      normalizeFindOrdersInput(dto({ confirmed: 'true' } as unknown as Partial<FindOrdersDto>))
        .confirmed,
    ).toBeUndefined();
  });

  it('trims the cursor and drops a blank one', () => {
    expect(normalizeFindOrdersInput(dto({ cursor: '  abc  ' })).cursor).toBe('abc');
    expect(normalizeFindOrdersInput(dto({ cursor: '   ' })).cursor).toBeUndefined();
  });

  it('keeps the period of the payment, either end alone too', () => {
    expect(normalizeFindOrdersInput(dto({ paidFrom: at(1), paidTo: at(5) }))).toMatchObject({
      paidFrom: at(1),
      paidTo: at(5),
    });
    expect(normalizeFindOrdersInput(dto({ paidFrom: at(1) }))).toMatchObject({
      paidFrom: at(1),
      paidTo: undefined,
    });
    expect(normalizeFindOrdersInput(dto({ paidTo: at(5) }))).toMatchObject({
      paidFrom: undefined,
      paidTo: at(5),
    });
  });

  // the period takes its start and stops before its end, so an end at its start holds nothing
  it.each([
    ['ends before it starts', at(5), at(1)],
    ['ends where it starts', at(5), at(5)],
  ])('rejects a period of the payment that %s', (_case, paidFrom, paidTo) => {
    expect(thrownBy(() => normalizeFindOrdersInput(dto({ paidFrom, paidTo })))).toMatchObject({
      statusCode: 400,
      errorCode: 'PAID_PERIOD_INVALID',
    });
  });

  it('keeps the period of the last change, either end alone too', () => {
    expect(normalizeFindOrdersInput(dto({ updatedFrom: at(1), updatedTo: at(5) }))).toMatchObject({
      updatedFrom: at(1),
      updatedTo: at(5),
    });
    expect(normalizeFindOrdersInput(dto({ updatedTo: at(5) }))).toMatchObject({
      updatedFrom: undefined,
      updatedTo: at(5),
    });
  });

  it.each([
    ['ends before it starts', at(5), at(1)],
    ['ends where it starts', at(5), at(5)],
  ])('rejects a period of the last change that %s', (_case, updatedFrom, updatedTo) => {
    expect(thrownBy(() => normalizeFindOrdersInput(dto({ updatedFrom, updatedTo })))).toMatchObject(
      { statusCode: 400, errorCode: 'UPDATED_PERIOD_INVALID' },
    );
  });
});

const NOT_A_CART = { status: { not: 'pending' } };

describe('buildOrdersWhere', () => {
  it('limits a user to their own orders, without the cart', () => {
    expect(buildOrdersWhere({ actorId: 3, actorRole: 'USER', sortBy: 'createdAt' })).toEqual({
      userId: 3,
      ...NOT_A_CART,
    });
  });

  it.each(['ADMIN', 'ROOT'] as const)(
    'lets %s see the orders of every user, without the carts',
    (actorRole) => {
      expect(buildOrdersWhere({ actorId: 1, actorRole, sortBy: 'createdAt' })).toEqual(NOT_A_CART);
    },
  );

  it('adds the status and confirmed filters', () => {
    expect(
      buildOrdersWhere({
        actorId: 3,
        actorRole: 'USER',
        status: 'paid',
        confirmed: true,
        sortBy: 'total',
      }),
    ).toEqual({ userId: 3, status: 'paid', confirmed: true });
  });

  it('keeps a confirmed: false filter', () => {
    expect(
      buildOrdersWhere({ actorId: 1, actorRole: 'ADMIN', confirmed: false, sortBy: 'total' }),
    ).toEqual({ ...NOT_A_CART, confirmed: false });
  });

  it('leaves out orders without a delivery when they are sorted by its method or its price', () => {
    for (const sortBy of ['deliveryMethod', 'deliveryPrice'] as const) {
      expect(buildOrdersWhere({ actorId: 1, actorRole: 'ADMIN', sortBy })).toEqual({
        ...NOT_A_CART,
        AND: [{ delivery: { isNot: null } }],
      });
    }
  });

  it('leaves out the orders that go to no address (a pickup) when they are sorted by the destination', () => {
    expect(buildOrdersWhere({ actorId: 1, actorRole: 'ADMIN', sortBy: 'destination' })).toEqual({
      ...NOT_A_CART,
      AND: [{ delivery: { is: { country: { not: null } } } }],
    });
  });

  it('leaves out the orders that are not paid when they are sorted by the time of payment', () => {
    expect(buildOrdersWhere({ actorId: 1, actorRole: 'ADMIN', sortBy: 'paidAt' })).toEqual({
      ...NOT_A_CART,
      paidAt: { not: null },
    });
  });

  it('keeps the orders paid from the start of the period and before its end', () => {
    expect(
      buildOrdersWhere({
        actorId: 3,
        actorRole: 'USER',
        sortBy: 'createdAt',
        paidFrom: at(1),
        paidTo: at(5),
      }),
    ).toEqual({ userId: 3, ...NOT_A_CART, paidAt: { gte: at(1), lt: at(5) } });
  });

  it('keeps the orders changed from the start of the period and before its end', () => {
    expect(
      buildOrdersWhere({
        actorId: 3,
        actorRole: 'USER',
        sortBy: 'createdAt',
        updatedFrom: at(1),
        updatedTo: at(5),
      }),
    ).toEqual({ userId: 3, ...NOT_A_CART, updatedAt: { gte: at(1), lt: at(5) } });
    expect(
      buildOrdersWhere({ actorId: 3, actorRole: 'USER', sortBy: 'createdAt', updatedTo: at(5) }),
    ).toEqual({ userId: 3, ...NOT_A_CART, updatedAt: { lt: at(5) } });
  });

  it('lists the orders paid in the period by the time of payment', () => {
    const where = buildOrdersWhere({
      actorId: 1,
      actorRole: 'ADMIN',
      sortBy: 'paidAt',
      paidFrom: at(2),
      paidTo: at(9),
    });
    const visited = walkPages({
      rows: orders,
      where,
      orderBy: buildOrdersOrderBy('paidAt', 'asc'),
      limit: 2,
      cursorWhere: (cursor) => buildOrdersCursorWhere({ sortBy: 'paidAt', sortDir: 'asc', cursor }),
      nextCursor: (last) => makeNextOrdersCursor('paidAt', last, 'asc'),
    });

    expect(visited).toEqual([4, 5, 7]);
  });
});

describe('order list pagination', () => {
  describe.each(SORTS)('sorted by %s', (sortBy) => {
    it.each(DIRS)('visits every order exactly once, in order, going %s', (sortDir) => {
      const where = buildOrdersWhere({ actorId: 1, actorRole: 'ADMIN', sortBy });
      const orderBy = buildOrdersOrderBy(sortBy, sortDir);

      const visited = walkPages({
        rows: orders,
        where,
        orderBy,
        limit: 2,
        cursorWhere: (cursor) => buildOrdersCursorWhere({ sortBy, sortDir, cursor }),
        nextCursor: (last) => makeNextOrdersCursor(sortBy, last, sortDir),
      });

      // the orders a sort lists: the ones that have what it sorts by
      const hasSortField = (row: (typeof orders)[number]) => {
        if (sortBy === 'paidAt') return row.paidAt !== null;
        if (sortBy === 'deliveryMethod' || sortBy === 'deliveryPrice') return row.delivery !== null;
        if (sortBy === 'destination') return row.delivery?.country != null;
        return true;
      };
      const expected = sortRows(
        orders.filter((row) => row.status !== 'pending' && hasSortField(row)),
        orderBy,
      ).map((row) => row.id);

      expect(visited).toEqual(expected);
    });
  });

  it('breaks ties on the sort field by id in the same direction', () => {
    expect(buildOrdersOrderBy('total', 'asc')).toEqual([{ total: 'asc' }, { id: 'asc' }]);
    expect(buildOrdersOrderBy('updatedAt', 'desc')).toEqual([
      { updatedAt: 'desc' },
      { id: 'desc' },
    ]);
  });
});

describe('buildOrdersCursorWhere', () => {
  it('adds no condition without a cursor', () => {
    expect(buildOrdersCursorWhere({ sortBy: 'total', sortDir: 'asc' })).toBeUndefined();
  });

  it('rejects a cursor that is not base64url json', () => {
    expect(
      thrownBy(() => buildOrdersCursorWhere({ sortBy: 'total', sortDir: 'asc', cursor: '%%' })),
    ).toMatchObject({ statusCode: 400, errorCode: 'CURSOR_INVALID' });
  });

  // a cursor comes back from the client: a changed one is a bad request, not a server error
  it.each([
    ['a date sort gets a word', 'updatedAt', 'yesterday'],
    ['a date sort gets null', 'updatedAt', null],
    ['the creation date sort gets a word', 'createdAt', 'yesterday'],
    ['the payment date sort gets a word', 'paidAt', 'yesterday'],
    ['the payment date sort gets null', 'paidAt', null],
    ['an amount sort gets a word', 'total', 'cheap'],
    ['an amount sort gets null', 'total', null],
    ['an amount sort gets a date from another sort', 'total', '2026-03-01T10:00:00.000Z'],
  ] as const)('rejects the cursor when %s', (_case, sortBy, v) => {
    const cursor = encodeCursor({ id: 4, v, s: `${sortBy}:desc` } as never);

    expect(
      thrownBy(() => buildOrdersCursorWhere({ sortBy, sortDir: 'desc', cursor })),
    ).toMatchObject({ statusCode: 400, errorCode: 'CURSOR_INVALID' });
  });
});

describe('makeNextOrdersCursor', () => {
  const last = orders[3]!;

  it.each([
    ['createdAt', '2026-03-02T10:00:00.000Z'],
    ['updatedAt', '2026-03-02T10:00:00.000Z'],
    ['paidAt', '2026-03-02T10:00:00.000Z'],
    ['total', 99.99],
    ['deliveryMethod', 'manual'],
    ['deliveryPrice', 5],
    ['destination', 'UA\u0001Kyiv'],
  ] as const)('puts the %s of the last row next to its id, with the sort', (sortBy, v) => {
    expect(decodeCursor(makeNextOrdersCursor(sortBy, last, 'desc'))).toEqual({
      id: 4,
      v,
      s: `${sortBy}:desc`,
    });
  });
});

// a cursor names its sort and direction: one of another, or one without them, starts the page
// from an order of another order
describe('buildOrdersCursorWhere and the sort of a cursor', () => {
  const cursorOf = (s?: string) =>
    encodeCursor({ id: 4, v: '2026-03-02T10:00:00.000Z', ...(s ? { s } : {}) } as never);

  it.each([
    ['another direction', 'createdAt:asc'],
    ['another sort', 'updatedAt:desc'],
    ['no sort', undefined],
  ])('rejects the cursor of %s', (_case, s) => {
    expect(
      thrownBy(() =>
        buildOrdersCursorWhere({ sortBy: 'createdAt', sortDir: 'desc', cursor: cursorOf(s) }),
      ),
    ).toMatchObject({ statusCode: 400, errorCode: 'CURSOR_INVALID' });
  });

  it('takes the cursor of its own sort and direction', () => {
    expect(
      buildOrdersCursorWhere({
        sortBy: 'createdAt',
        sortDir: 'desc',
        cursor: cursorOf('createdAt:desc'),
      }),
    ).toBeDefined();
  });
});

// the desk of an admin: the filters a buyer may not send
describe('normalizeFindOrdersInput and the desk', () => {
  it.each(['userId', 'q', 'format'] as const)('refuses %s to a buyer', (filter) => {
    expect(
      thrownBy(() => normalizeFindOrdersInput(dto({ [filter]: filter === 'format' ? 'csv' : 1 }))),
    ).toMatchObject({ statusCode: 403, errorCode: 'FILTER_FORBIDDEN', details: { filter } });
  });

  it.each(['ADMIN', 'ROOT'] as const)('lets %s use the filters of the desk', (actorRole) => {
    expect(
      normalizeFindOrdersInput(dto({ actorRole, userId: 5, q: '  Koval ', format: 'csv' })),
    ).toMatchObject({ userId: 5, q: 'Koval' });
  });

  it('drops a text of spaces, and orders as asked', () => {
    expect(normalizeFindOrdersInput(dto({ actorRole: 'ADMIN', q: '   ' })).q).toBeUndefined();
    expect(normalizeFindOrdersInput(dto({ sortDir: 'asc' })).sortDir).toBe('asc');
  });

  it('takes statuses with spaces around them, and refuses a list with one unknown status', () => {
    expect(normalizeFindOrdersInput(dto({ statuses: ' paid , shipped ' })).statuses).toEqual([
      'paid',
      'shipped',
    ]);
    expect(thrownBy(() => normalizeFindOrdersInput(dto({ statuses: 'paid,lost' })))).toMatchObject({
      errorCode: 'STATUS_INVALID',
    });
  });

  it('takes a few statuses and refuses one the list has not', () => {
    expect(
      normalizeFindOrdersInput(dto({ actorRole: 'ADMIN', statuses: 'paid,shipped,paid' })).statuses,
    ).toEqual(['paid', 'shipped']);
    expect(
      thrownBy(() => normalizeFindOrdersInput(dto({ actorRole: 'ADMIN', statuses: 'pending' }))),
    ).toMatchObject({ errorCode: 'STATUS_INVALID' });
  });
});

describe('buildOrdersWhere and the desk', () => {
  const base = { actorId: 1, actorRole: 'ADMIN', sortBy: 'createdAt' } as const;

  it('finds an order by its number, and by a part of the buyer or the recipient otherwise', () => {
    const digits = { contains: '42', mode: 'insensitive' };
    expect(buildOrdersWhere({ ...base, q: '42' })).toMatchObject({
      OR: [
        { id: 42 },
        { delivery: { is: { postalCode: digits } } },
        { shipments: { some: { trackingNumber: digits } } },
      ],
    });
    const like = { contains: 'koval', mode: 'insensitive' };
    expect(buildOrdersWhere({ ...base, q: 'koval' })).toMatchObject({
      OR: [
        { user: { email: like } },
        { delivery: { is: { recipientFirstName: like } } },
        { delivery: { is: { recipientLastName: like } } },
        { delivery: { is: { recipientPhone: like } } },
        { delivery: { is: { city: like } } },
        { delivery: { is: { postalCode: like } } },
        { shipments: { some: { trackingNumber: like } } },
      ],
    });
  });

  // a number is a number of an order only as a whole number from 1 the ids of the database hold
  it.each([
    ['a number of one digit', '4', { id: 4 }],
    ['a number of three digits', '123', { id: 123 }],
    ['the last id', '2147483647', { id: 2_147_483_647 }],
  ])('finds an order by %s', (_case, q, where) => {
    expect(buildOrdersWhere({ ...base, q })).toMatchObject({ OR: expect.arrayContaining([where]) });
  });

  it.each([
    ['a number past the last id', '2147483648'],
    ['a number with a zero in front', '042'],
    ['a letter before the number', 'a42'],
    ['a letter after the number', '42a'],
  ])('looks for %s as a text', (_case, q) => {
    const where = buildOrdersWhere({ ...base, q });

    expect(where).not.toHaveProperty('id');
    expect(where.OR).toHaveLength(7);
  });

  it('keeps one status within a few statuses', () => {
    expect(
      buildOrdersWhere({ ...base, statuses: ['paid', 'shipped'], status: 'paid' }),
    ).toMatchObject({ status: { in: ['paid', 'shipped'] }, AND: [{ status: 'paid' }] });
  });

  // prisma puts the text into a LIKE pattern as it is
  it('takes the wildcards of a pattern in the text as they are', () => {
    expect(buildOrdersWhere({ ...base, q: '50%_a\\b' })).toMatchObject({
      OR: expect.arrayContaining([
        {
          delivery: {
            is: { recipientPhone: { contains: '50\\%\\_a\\\\b', mode: 'insensitive' } },
          },
        },
      ]),
    });
  });

  it('keeps the orders of a buyer, of a few statuses and with a product', () => {
    expect(
      buildOrdersWhere({ ...base, userId: 7, statuses: ['paid', 'shipped'], productId: 9 }),
    ).toMatchObject({
      userId: 7,
      status: { in: ['paid', 'shipped'] },
      items: { some: { productId: 9 } },
    });
  });

  // a buyer sees only their own orders, whatever the request names
  it('keeps a buyer to their own orders', () => {
    expect(buildOrdersWhere({ ...base, actorRole: 'USER', actorId: 3, userId: 7 })).toMatchObject({
      userId: 3,
    });
  });
});

// the filters of the delivery on the desk of an admin: what the order goes with, where, who carries it
describe('the delivery filters of the desk', () => {
  const adminBase = { actorId: 1, actorRole: 'ADMIN', sortBy: 'createdAt' } as const;

  it.each([
    ['deliveryMethod', 'manual'],
    ['country', 'UA'],
    ['carrier', 'DHL'],
    ['shippedWithoutNumber', true],
    ['deliveryCharged', true],
    ['withoutWeight', true],
    ['shippingCostMissing', true],
    ['shippedTo', new Date('2026-03-01T00:00:00.000Z')],
  ] as const)('refuses %s to a buyer', (filter, value) => {
    expect(thrownBy(() => normalizeFindOrdersInput(dto({ [filter]: value })))).toMatchObject({
      statusCode: 403,
      errorCode: 'FILTER_FORBIDDEN',
      details: { filter },
    });
  });

  it('lets an admin send them, the methods and the countries through commas', () => {
    expect(
      normalizeFindOrdersInput(
        dto({
          actorRole: 'ADMIN',
          deliveryMethod: 'manual,pickup',
          country: 'UA,PL',
          carrier: ' DHL ',
        }),
      ),
    ).toMatchObject({
      deliveryMethod: ['manual', 'pickup'],
      country: ['UA', 'PL'],
      carrier: 'DHL',
    });
  });

  it('keeps the orders of the methods and of the countries', () => {
    expect(
      buildOrdersWhere({ ...adminBase, deliveryMethod: ['pickup'], country: ['UA', 'PL'] }),
    ).toMatchObject({
      AND: [
        { delivery: { is: { method: { in: ['pickup'] } } } },
        { delivery: { is: { country: { in: ['UA', 'PL'] } } } },
      ],
    });
  });

  it('keeps the orders whose delivery the buyer pays for, or does not', () => {
    expect(buildOrdersWhere({ ...adminBase, deliveryCharged: true })).toMatchObject({
      AND: [{ delivery: { is: { price: { gt: 0 } } } }],
    });
    expect(buildOrdersWhere({ ...adminBase, deliveryCharged: false })).toMatchObject({
      AND: [{ delivery: { is: { price: { equals: 0 } } } }],
    });
  });

  it('looks for the carrier among the sends that were not taken back, the wildcards as text', () => {
    expect(buildOrdersWhere({ ...adminBase, carrier: 'D_H%L' })).toMatchObject({
      AND: [
        {
          shipments: {
            some: { rolledBackAt: null, carrier: { contains: 'D\\_H\\%L', mode: 'insensitive' } },
          },
        },
      ],
    });
  });

  it('keeps the shipped orders whose send has no number', () => {
    expect(buildOrdersWhere({ ...adminBase, shippedWithoutNumber: true })).toMatchObject({
      AND: [
        { status: 'shipped', shipments: { some: { rolledBackAt: null, trackingNumber: null } } },
      ],
    });
  });

  it('keeps the orders that hold a product without a weight', () => {
    expect(buildOrdersWhere({ ...adminBase, withoutWeight: true })).toMatchObject({
      AND: [{ items: { some: { product: { weightGrams: null } } } }],
    });
  });

  // the cost and the time are about one send: a send that lacks its cost and was sent before a time
  it('keeps the orders with a send the shop owes something for and wrote no cost of, sent before a time', () => {
    const before = new Date('2026-03-01T00:00:00.000Z');

    expect(buildOrdersWhere({ ...adminBase, shippingCostMissing: true })).toMatchObject({
      AND: [{ shipments: { some: { expense: true, cost: null } } }],
    });
    expect(buildOrdersWhere({ ...adminBase, shippedTo: before })).toMatchObject({
      AND: [{ shipments: { some: { shippedAt: { lt: before } } } }],
    });
    expect(
      buildOrdersWhere({ ...adminBase, shippingCostMissing: true, shippedTo: before }),
    ).toMatchObject({
      AND: [{ shipments: { some: { expense: true, cost: null, shippedAt: { lt: before } } } }],
    });
  });
});

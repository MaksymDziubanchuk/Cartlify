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

const order = (
  id: number,
  userId: number,
  status: string,
  total: string,
  shippingAddress: string | null,
  createdDay: number,
  updatedDay: number,
  paidDay: number | null,
) => ({
  id,
  userId,
  status,
  total: new Prisma.Decimal(total),
  shippingAddress,
  createdAt: at(createdDay),
  updatedAt: at(updatedDay),
  paidAt: paidDay === null ? null : at(paidDay),
});

// ties on every sort field, so the id has to break them; the carts (pending) are never listed,
// the orders that are not paid have no time of payment
const orders = [
  order(1, 3, 'paid', '10.00', 'Kyiv', 1, 1, 1),
  order(2, 3, 'unconfirmed', '25.50', null, 1, 2, null),
  order(3, 4, 'waiting', '10.00', 'Lviv', 2, 2, null),
  order(4, 3, 'shipped', '99.99', 'Kyiv', 2, 2, 2),
  order(5, 4, 'delivered', '25.50', 'Odesa', 2, 5, 2),
  order(6, 3, 'unconfirmed', '0.00', null, 5, 5, null),
  order(7, 5, 'cancelled', '10.00', 'Kyiv', 6, 7, 6),
  order(8, 5, 'paid', '99.99', 'Lviv', 1, 1, 1),
  order(9, 3, 'paid', '25.50', 'Odesa', 9, 9, 9),
  order(10, 3, 'pending', '25.50', 'Kyiv', 9, 9, null),
  order(11, 4, 'pending', '0.00', null, 3, 3, null),
];

const SORTS: OrdersSortBy[] = ['createdAt', 'updatedAt', 'total', 'shippingAddress', 'paidAt'];
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

  it('leaves out orders without a shipping address when they are sorted by it', () => {
    expect(buildOrdersWhere({ actorId: 1, actorRole: 'ADMIN', sortBy: 'shippingAddress' })).toEqual(
      { ...NOT_A_CART, shippingAddress: { not: null } },
    );
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
      nextCursor: (last) => makeNextOrdersCursor('paidAt', last),
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
        nextCursor: (last) => makeNextOrdersCursor(sortBy, last),
      });

      const expected = sortRows(
        orders.filter(
          (row) =>
            row.status !== 'pending' &&
            (sortBy !== 'shippingAddress' || row.shippingAddress !== null) &&
            (sortBy !== 'paidAt' || row.paidAt !== null),
        ),
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
    const cursor = encodeCursor({ id: 4, v });

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
    ['shippingAddress', 'Kyiv'],
  ] as const)('puts the %s of the last row next to its id', (sortBy, v) => {
    expect(decodeCursor(makeNextOrdersCursor(sortBy, last))).toEqual({ id: 4, v });
  });
});

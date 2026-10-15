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

// ties on every sort field, so the id has to break them
const orders = [
  {
    id: 1,
    userId: 3,
    total: new Prisma.Decimal('10.00'),
    shippingAddress: 'Kyiv',
    updatedAt: at(1),
  },
  { id: 2, userId: 3, total: new Prisma.Decimal('25.50'), shippingAddress: null, updatedAt: at(2) },
  {
    id: 3,
    userId: 4,
    total: new Prisma.Decimal('10.00'),
    shippingAddress: 'Lviv',
    updatedAt: at(2),
  },
  {
    id: 4,
    userId: 3,
    total: new Prisma.Decimal('99.99'),
    shippingAddress: 'Kyiv',
    updatedAt: at(2),
  },
  {
    id: 5,
    userId: 4,
    total: new Prisma.Decimal('25.50'),
    shippingAddress: 'Odesa',
    updatedAt: at(5),
  },
  { id: 6, userId: 3, total: new Prisma.Decimal('0.00'), shippingAddress: null, updatedAt: at(5) },
  {
    id: 7,
    userId: 5,
    total: new Prisma.Decimal('10.00'),
    shippingAddress: 'Kyiv',
    updatedAt: at(7),
  },
  {
    id: 8,
    userId: 5,
    total: new Prisma.Decimal('99.99'),
    shippingAddress: 'Lviv',
    updatedAt: at(1),
  },
  {
    id: 9,
    userId: 3,
    total: new Prisma.Decimal('25.50'),
    shippingAddress: 'Odesa',
    updatedAt: at(9),
  },
];

const SORTS: OrdersSortBy[] = ['updatedAt', 'total', 'shippingAddress'];
const DIRS: OrdersSortDir[] = ['asc', 'desc'];

describe('normalizeFindOrdersInput', () => {
  it('lists 20 orders, the last updated first, when the query sets nothing', () => {
    expect(normalizeFindOrdersInput(dto())).toMatchObject({
      limit: 20,
      sortBy: 'updatedAt',
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

  it.each(['pending', 'waiting', 'unconfirmed', 'paid', 'shipped', 'delivered', 'cancelled'])(
    'accepts the %s status filter',
    (status) => {
      expect(normalizeFindOrdersInput(dto({ status } as Partial<FindOrdersDto>)).status).toBe(
        status,
      );
    },
  );

  it('rejects an unknown status', () => {
    const input = dto({ status: 'lost' } as unknown as Partial<FindOrdersDto>);

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
});

describe('buildOrdersWhere', () => {
  it('limits a user to their own orders', () => {
    expect(buildOrdersWhere({ actorId: 3, actorRole: 'USER', sortBy: 'updatedAt' })).toEqual({
      userId: 3,
    });
  });

  it.each(['ADMIN', 'ROOT'] as const)('lets %s see the orders of every user', (actorRole) => {
    expect(buildOrdersWhere({ actorId: 1, actorRole, sortBy: 'updatedAt' })).toEqual({});
  });

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
    ).toEqual({ confirmed: false });
  });

  it('leaves out orders without a shipping address when they are sorted by it', () => {
    expect(buildOrdersWhere({ actorId: 1, actorRole: 'ADMIN', sortBy: 'shippingAddress' })).toEqual(
      { shippingAddress: { not: null } },
    );
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
        orders.filter((row) => sortBy !== 'shippingAddress' || row.shippingAddress !== null),
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
    ['updatedAt', '2026-03-02T10:00:00.000Z'],
    ['total', 99.99],
    ['shippingAddress', 'Kyiv'],
  ] as const)('puts the %s of the last row next to its id', (sortBy, v) => {
    expect(decodeCursor(makeNextOrdersCursor(sortBy, last))).toEqual({ id: 4, v });
  });
});

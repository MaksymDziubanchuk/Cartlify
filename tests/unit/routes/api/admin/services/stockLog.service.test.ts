import { describe, expect, it } from '@jest/globals';

import { STOCK_LOG_EVENTS } from '@config/journalEvents.js';
import { stockLogArgsOf } from '@routes/api/admin/services/stockLog.service.js';
import type { UserId } from 'types/ids.js';

import { thrownBy } from '../../../../../helpers/errors.js';

// what a query of the stock log is made of: its filters, its sorts, its events. The lines
// themselves come from the database (tests/integration/api/admin/stockLog.test.ts)

const actor = { id: 7 as UserId, role: 'ADMIN' as const };

describe('stockLogArgsOf', () => {
  it('takes every filter as it is, the operation ids in lower case', () => {
    const args = stockLogArgsOf(
      {
        productId: 3,
        variantId: 31,
        orderId: 12,
        deliveryId: '7D1F4F6E-6B1F-4A43-9A1B-0D2A3C4B5E6F',
        writeOffId: '0815623E-1FB7-409E-B373-4D7105E1A8CC',
      },
      actor,
    );

    expect(args).toMatchObject({
      productId: 3,
      variantId: 31,
      orderId: 12,
      deliveryId: '7d1f4f6e-6b1f-4a43-9a1b-0d2a3c4b5e6f',
      writeOffId: '0815623e-1fb7-409e-b373-4d7105e1a8cc',
    });
  });

  it('has no filter unless it is asked for', () => {
    const args = stockLogArgsOf({}, actor);

    expect(args).toMatchObject({
      productId: undefined,
      variantId: undefined,
      orderId: undefined,
      deliveryId: undefined,
      writeOffId: undefined,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
  });

  it('sorts by any column of the journal that is a simple one', () => {
    for (const sortBy of ['quantityChange', 'stockAfter', 'deliveryId', 'orderId', 'variantId']) {
      expect(stockLogArgsOf({ sortBy }, actor).sortBy).toBe(sortBy);
    }
  });

  it('refuses a sort by a column it does not sort by, and names the ones it does', () => {
    const err = thrownBy(() => stockLogArgsOf({ sortBy: 'changes' }, actor));

    expect(err).toMatchObject({
      errorCode: 'LOG_SORT_INVALID',
      details: { sortBy: 'changes', allowed: expect.arrayContaining(['quantityChange']) },
    });
  });

  it('takes the events of the stock log and none of an old line', () => {
    expect(stockLogArgsOf({ events: 'stock.sale,stock.cancel_return' }, actor).events).toEqual([
      'stock.sale',
      'stock.cancel_return',
    ]);

    const err = thrownBy(() => stockLogArgsOf({ events: 'legacy.unknown,order.ship' }, actor));

    expect(err).toMatchObject({
      errorCode: 'LOG_EVENTS_INVALID',
      details: {
        events: ['legacy.unknown', 'order.ship'],
        allowed: [...STOCK_LOG_EVENTS],
      },
    });
  });
});

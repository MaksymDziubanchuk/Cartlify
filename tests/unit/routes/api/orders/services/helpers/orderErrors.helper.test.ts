import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { isOrderNotEditable } from '@routes/api/orders/services/helpers/orderErrors.helper.js';

// a prisma error the way the pg adapter of prisma 7 builds it for a failed query
const pgError = (message: string) =>
  new Prisma.PrismaClientKnownRequestError('Query failed', {
    code: 'P2010',
    clientVersion: '7.10.1',
    meta: {
      driverAdapterError: {
        cause: { originalCode: '23514', originalMessage: message, kind: 'postgres' },
      },
    },
  });

describe('isOrderNotEditable', () => {
  it.each(['ORDER_NOT_EDITABLE', 'ORDER_ALREADY_CONFIRMED'])(
    'is true when the items trigger refuses the change with %s',
    (message) => {
      expect(isOrderNotEditable(pgError(message))).toBe(true);
    },
  );

  it.each(['PRODUCT_NOT_FOUND', 'ORDER_NOT_FOUND', 'ORDER_CONFIRMED_CHANGE_FORBIDDEN'])(
    'is false for another database error, %s',
    (message) => {
      expect(isOrderNotEditable(pgError(message))).toBe(false);
    },
  );

  it('is false for an error that does not come from the database', () => {
    expect(isOrderNotEditable(new Error('ORDER_NOT_EDITABLE'))).toBe(false);
    expect(isOrderNotEditable(undefined)).toBe(false);
  });
});

import { describe, expect, it } from '@jest/globals';

import { failureOf } from '@helpers/failureOf.js';
import { InternalError, ServiceUnavailableError } from '@utils/errors.js';

describe('failureOf', () => {
  // a connection error quotes the address of the database or of redis: never in a log line
  it('tells the kind and the code of an error, not its message', () => {
    const err = Object.assign(new Error("Can't reach database server at db.example.test:5432"), {
      code: 'P1001',
    });

    expect(failureOf(err)).toEqual({ type: 'Error', code: 'P1001' });
    expect(JSON.stringify(failureOf(err))).not.toContain('db.example.test');
  });

  it('tells the type of a stripe error', () => {
    expect(failureOf({ type: 'StripeConnectionError', name: 'Error' })).toEqual({
      type: 'StripeConnectionError',
      code: undefined,
    });
  });

  it('tells the reason of an internal error and the code of our other errors', () => {
    expect(failureOf(new InternalError({ reason: 'PAYMENT_PAGE_NOT_CLOSED' }))).toMatchObject({
      code: 'PAYMENT_PAGE_NOT_CLOSED',
    });
    expect(failureOf(new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE'))).toMatchObject({
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
    });
  });

  it('gives nothing for something that is not an error', () => {
    expect(failureOf(undefined)).toEqual({ type: undefined, code: undefined });
  });
});

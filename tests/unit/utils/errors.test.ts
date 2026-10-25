import { describe, expect, it } from '@jest/globals';

import {
  AccessTokenExpiredError,
  AlreadyAuthenticatedError,
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  isAppError,
  isErrorNamed,
} from '@utils/errors.js';

describe('error classes', () => {
  it.each([
    [BadRequestError, 400, 'BAD_REQUEST', 'Bad Request'],
    [UnauthorizedError, 401, 'UNAUTHORIZED', 'Unauthorized'],
    [ForbiddenError, 403, 'FORBIDDEN', 'Forbidden'],
    [NotFoundError, 404, 'NOT_FOUND', 'Not Found'],
    [ConflictError, 409, 'CONFLICT', 'Conflict'],
    [TooManyRequestsError, 429, 'RATE_LIMITED', 'Too Many Requests'],
    [ServiceUnavailableError, 503, 'SERVICE_UNAVAILABLE', 'Service Unavailable'],
  ])(
    '%p has status %p, default code %p and the http phrase as message',
    (Cls, status, code, phrase) => {
      const err = new Cls();

      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({ statusCode: status, errorCode: code, message: phrase });
      expect(err.name).toBe(Cls.name);
    },
  );

  it('keeps a custom error code, details and cause', () => {
    const cause = new Error('db said no');
    const err = new BadRequestError('PRICE_INVALID', { field: 'price' }, cause);

    expect(err.errorCode).toBe('PRICE_INVALID');
    expect(err.details).toEqual({ field: 'price' });
    expect(err.cause).toBe(cause);
  });

  it('shows details of client errors and hides details of server errors', () => {
    expect(new NotFoundError('X', { id: 1 }).expose).toBe(true);
    expect(new InternalError({ secret: 'x' }).expose).toBe(false);
  });

  // the attempts and the database codes of a busy error are for the log, the client retries
  it('keeps the details of a busy error from the client', () => {
    const err = new ResourceBusyError({ attempts: 4, pgCode: '40P01' });

    expect(err.expose).toBe(false);
    expect(err.details).toEqual({ attempts: 4, pgCode: '40P01' });
  });

  it('gives every internal error the same code, whatever the details', () => {
    const err = new InternalError({ reason: 'SOMETHING' });

    expect(err).toMatchObject({ statusCode: 500, errorCode: 'INTERNAL_ERROR' });
  });

  it.each([
    [AccessTokenExpiredError, UnauthorizedError, 401, 'ACCESS_TOKEN_EXPIRED'],
    [AlreadyAuthenticatedError, ConflictError, 409, 'ALREADY_AUTHENTICATED'],
    [ResourceBusyError, ConflictError, 409, 'RESOURCE_BUSY'],
  ])('%p is a %p with status %p and code %p', (Cls, Parent, status, code) => {
    const err = new Cls();

    expect(err).toBeInstanceOf(Parent);
    expect(err).toMatchObject({ statusCode: status, errorCode: code });
    expect(err.name).toBe(Cls.name);
  });
});

describe('isAppError', () => {
  it('is true for app errors and for objects with the same shape', () => {
    expect(isAppError(new NotFoundError())).toBe(true);
    expect(isAppError({ statusCode: 400, errorCode: 'X' })).toBe(true);
  });

  it.each([
    ['a plain error', new Error('x')],
    ['an error with only a status', Object.assign(new Error('x'), { statusCode: 400 })],
    ['a string status', { statusCode: '400', errorCode: 'X' }],
    ['null', null],
    ['a string', 'BAD_REQUEST'],
  ])('is false for %s', (_case, value) => {
    expect(isAppError(value)).toBe(false);
  });
});

describe('isErrorNamed', () => {
  it('matches by error name', () => {
    const err = Object.assign(new Error('expired'), { name: 'TokenExpiredError' });

    expect(isErrorNamed(err, 'TokenExpiredError')).toBe(true);
    expect(isErrorNamed(err, 'JsonWebTokenError')).toBe(false);
  });

  it('is false for values that are not objects', () => {
    expect(isErrorNamed(null, 'Error')).toBe(false);
    expect(isErrorNamed('Error', 'Error')).toBe(false);
  });
});

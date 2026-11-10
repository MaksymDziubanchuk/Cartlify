import { describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';

import {
  newsletterErrorOf,
  withNewsletterErrors,
} from '@routes/api/newsletters/services/helpers/newsletterErrors.helper.js';
import { BadRequestError, ResourceBusyError } from '@utils/errors.js';

// a raised exception of a function of the database, as prisma reports it with the pg adapter: the
// message of the exception is in meta.driverAdapterError.cause.originalMessage
const raised = (message: string, code = 'P0001') =>
  new Prisma.PrismaClientKnownRequestError('Raw query failed', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: code, originalMessage: message } } },
  });

describe('newsletterErrorOf', () => {
  // the table of the codes of db/05 and the answers of the API, in one place
  it.each([
    ['NEWSLETTER_LINK_INVALID', 400, 'NEWSLETTER_LINK_INVALID'],
    ['NEWSLETTER_LOCALE_INVALID', 400, 'LOCALE_INVALID'],
    ['NEWSLETTER_LOCALE_NOT_ALLOWED', 409, 'NEWSLETTER_LOCALE_NOT_ALLOWED'],
    ['NEWSLETTER_EMAIL_NOT_VERIFIED', 403, 'NEWSLETTER_EMAIL_NOT_VERIFIED'],
    ['NEWSLETTER_FORBIDDEN', 403, 'NEWSLETTER_FORBIDDEN'],
  ])('answers %s with %s %s', (code, status, errorCode) => {
    const error = newsletterErrorOf(raised(code));

    expect(error).toMatchObject({ statusCode: status, errorCode });
    expect(error.expose).toBe(true);
  });

  // the codes of a fault of the server never become an answer of the API; the cause stays for the log
  it.each([
    'NEWSLETTER_PLACE_INVALID',
    'NEWSLETTER_EVENT_INVALID',
    'NEWSLETTER_TARGET_NOT_ADMIN',
    'NEWSLETTER_LOCALE_STILL_ENABLED',
    'NEWSLETTER_SUBSCRIPTION_UPDATE_FORBIDDEN',
    'something else the database says',
  ])('turns %s into a server error that leaks nothing', (code) => {
    const cause = raised(code, '42501');
    const error = newsletterErrorOf(cause);

    expect(error).toMatchObject({ statusCode: 500, errorCode: 'INTERNAL_ERROR', expose: false });
    expect(error.cause).toBe(cause);
    // what the client reads of an error: the status, the code, the phrase; the details of a server
    // error are kept back (expose is false), the cause is for the log
    expect(error.message).toBe('Internal Server Error');
    expect(error.errorCode).not.toContain('NEWSLETTER');
  });

  it('turns an error that is no error of the database into a server error', () => {
    expect(newsletterErrorOf(new Error('boom'))).toMatchObject({ statusCode: 500 });
    expect(newsletterErrorOf('text')).toMatchObject({ statusCode: 500 });
    expect(newsletterErrorOf(undefined)).toMatchObject({ statusCode: 500 });
  });

  it('keeps an error of the app as it is', () => {
    const own = new BadRequestError('LOCALE_INVALID');
    const busy = new ResourceBusyError({ reason: 'TEST' });

    expect(newsletterErrorOf(own)).toBe(own);
    expect(newsletterErrorOf(busy)).toBe(busy);
  });
});

describe('withNewsletterErrors', () => {
  it('gives back what the call gave', async () => {
    await expect(withNewsletterErrors(async () => 7)).resolves.toBe(7);
  });

  it('throws the error the failure deserves', async () => {
    await expect(
      withNewsletterErrors(async () => {
        throw raised('NEWSLETTER_LINK_INVALID');
      }),
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'NEWSLETTER_LINK_INVALID' });
  });
});

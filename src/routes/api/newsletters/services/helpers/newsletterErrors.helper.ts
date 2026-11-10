import { getPgMessage } from '@db/client.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  isAppError,
} from '@utils/errors.js';

// The codes the functions of the database raise for a request that cannot be done, and the answer
// of the API for each. One place for all the routes of the newsletters, so a code means the same
// thing wherever it comes from (db/05, the section NEWSLETTERS). The message of a raised exception
// is the code itself.
// A code the table does not name is a fault of the server and never reaches the person:
// NEWSLETTER_PLACE_INVALID and NEWSLETTER_EVENT_INVALID (the server chose a wrong place or event),
// NEWSLETTER_TARGET_NOT_ADMIN and NEWSLETTER_LOCALE_STILL_ENABLED (routes that are not these), the
// refusals of the checks of a table (a hash, a salt, an address the API let through) and anything
// else the database says
const REFUSALS: readonly (readonly [string, () => AppError])[] = [
  // the link was never given, or its subscription is over; the same answer for both
  ['NEWSLETTER_LINK_INVALID', () => new BadRequestError('NEWSLETTER_LINK_INVALID')],
  // the server checks the languages of the shop before it asks; this is the database saying that
  // a code is not two small letters
  ['NEWSLETTER_LOCALE_INVALID', () => new BadRequestError('LOCALE_INVALID')],
  // the language of a subscription of the form is changed on the page of its links, of an account
  // in the profile
  ['NEWSLETTER_LOCALE_NOT_ALLOWED', () => new ConflictError('NEWSLETTER_LOCALE_NOT_ALLOWED')],
  ['NEWSLETTER_EMAIL_NOT_VERIFIED', () => new ForbiddenError('NEWSLETTER_EMAIL_NOT_VERIFIED')],
  ['NEWSLETTER_FORBIDDEN', () => new ForbiddenError('NEWSLETTER_FORBIDDEN')],
];

// The error to throw for whatever a call of the database ended in: an error of the app stays as it
// is, a refusal of a function becomes its answer, the rest is a server error with the cause kept
// for the log
export function newsletterErrorOf(err: unknown): AppError {
  if (isAppError(err)) return err;

  const message = getPgMessage(err) ?? '';
  const refusal = REFUSALS.find(([code]) => message.includes(code));

  return refusal ? refusal[1]() : new InternalError({ reason: 'NEWSLETTER_UNEXPECTED' }, err);
}

// runs a call of the database and throws the error it deserves
export async function withNewsletterErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw newsletterErrorOf(err);
  }
}

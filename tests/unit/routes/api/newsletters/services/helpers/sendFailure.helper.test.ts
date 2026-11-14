import { describe, expect, it } from '@jest/globals';

import { sendFailureOf } from '@routes/api/newsletters/services/helpers/sendFailure.helper.js';
import { BadRequestError, InternalError } from '@utils/errors.js';

import type { MailRefusal } from '@providers/mail/index.js';

// what a failed send of a newsletter mail means for the pass: tried again at a later claim (retry),
// never to be accepted (refused), or a problem of the whole stream that stops the pass (halt)

// the error a mail provider throws when it refuses a mail, with whose fault it is and its status
const refusedWith = (failure: MailRefusal, status = 400) =>
  new InternalError({ reason: 'MAIL_PROVIDER_REFUSED', failure }, { status, body: { errors: [] } });

describe('sendFailureOf', () => {
  it.each([
    ['refused', 400, 'refused', false],
    ['account', 401, 'halt', true],
    ['busy', 429, 'retry', false],
    ['busy', 503, 'retry', false],
  ] as const)(
    'puts a refusal that is the fault of %s (status %s) in the class %s',
    (failure, status, kind, account) => {
      expect(sendFailureOf(refusedWith(failure, status))).toEqual({
        kind,
        account,
        status,
        reason: 'MAIL_PROVIDER_REFUSED',
      });
    },
  );

  it('retries a mail the provider did not answer in time, or at all', () => {
    const silence = new InternalError(
      { reason: 'MAIL_PROVIDER_UNREACHABLE' },
      new Error('aborted'),
    );

    expect(sendFailureOf(silence)).toEqual({
      kind: 'retry',
      account: false,
      status: null,
      reason: 'MAIL_PROVIDER_UNREACHABLE',
    });
  });

  it('retries a refusal that does not say whose fault it is, or has no status', () => {
    expect(
      sendFailureOf(new InternalError({ reason: 'MAIL_PROVIDER_REFUSED' }, 'no status')),
    ).toMatchObject({ kind: 'retry', status: null });
    expect(
      sendFailureOf(new InternalError({ reason: 'MAIL_PROVIDER_REFUSED', failure: 'other' })).kind,
    ).toBe('retry');
  });

  it.each([
    [
      'the stream has no key of the provider',
      new InternalError({ reason: 'MAIL_PROVIDER_NOT_CONFIGURED', stream: 'newsletter' }),
    ],
    [
      'the sender of the stream is missing',
      new InternalError({ reason: 'NEWSLETTER_EMAIL_FROM_REQUIRED' }),
    ],
    ['a header is not valid', new InternalError({ reason: 'NEWSLETTER_HEADER_INVALID' })],
    ['an address of the API is missing', new InternalError({ reason: 'API_ORIGIN_REQUIRED' })],
    ['an error of our own that is not an internal one', new BadRequestError('SOMETHING')],
    ['a plain error', new Error('boom')],
    ['something that is not an error', 'text'],
    ['nothing', undefined],
  ])('halts the pass when %s', (_what, err) => {
    expect(sendFailureOf(err)).toMatchObject({ kind: 'halt', account: false });
  });

  it('never carries the answer of the provider, which may name the address', () => {
    const failure = sendFailureOf(
      new InternalError(
        { reason: 'MAIL_PROVIDER_REFUSED', failure: 'refused' },
        { status: 400, body: { errors: [{ message: 'bad address nobody@example.com' }] } },
      ),
    );

    expect(JSON.stringify(failure)).not.toContain('nobody@example.com');
  });
});

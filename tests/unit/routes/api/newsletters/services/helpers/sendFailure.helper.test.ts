import { describe, expect, it } from '@jest/globals';

import { sendFailureOf } from '@routes/api/newsletters/services/helpers/sendFailure.helper.js';
import { BadRequestError, InternalError } from '@utils/errors.js';

// what a failed send of a newsletter mail means for the pass: tried again at a later claim (retry),
// never to be accepted (refused), or a problem of the whole stream that stops the pass (halt)

// the error postToSendGrid throws when SendGrid answers with a status
const refusedWith = (status: number) =>
  new InternalError({ reason: 'SENDGRID_SEND_FAILED' }, { status, body: { errors: [] } });

describe('sendFailureOf', () => {
  it.each([
    [400, 'refused'],
    [404, 'refused'],
    [413, 'refused'],
    [422, 'refused'],
    [499, 'refused'],
    [401, 'halt'],
    [403, 'halt'],
    [429, 'retry'],
    [500, 'retry'],
    [502, 'retry'],
    [503, 'retry'],
    [599, 'retry'],
  ] as const)('puts the status %s in the class %s', (status, kind) => {
    expect(sendFailureOf(refusedWith(status))).toEqual({
      kind,
      status,
      reason: 'SENDGRID_SEND_FAILED',
    });
  });

  it('retries a mail SendGrid did not answer in time, or at all', () => {
    const silence = new InternalError({ reason: 'SENDGRID_REQUEST_FAILED' }, new Error('aborted'));

    expect(sendFailureOf(silence)).toEqual({
      kind: 'retry',
      status: null,
      reason: 'SENDGRID_REQUEST_FAILED',
    });
  });

  it('retries an answer of SendGrid that is not a status it knows, or has none', () => {
    expect(sendFailureOf(refusedWith(302)).kind).toBe('retry');
    expect(
      sendFailureOf(new InternalError({ reason: 'SENDGRID_SEND_FAILED' }, 'no status')).kind,
    ).toBe('retry');
    expect(sendFailureOf(new InternalError({ reason: 'SENDGRID_SEND_FAILED' })).kind).toBe('retry');
  });

  it.each([
    [
      'the key of the stream is missing',
      new InternalError({ reason: 'SENDGRID_NEWSLETTER_API_KEY_REQUIRED' }),
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
    expect(sendFailureOf(err).kind).toBe('halt');
  });

  it('never carries the answer of SendGrid, which may name the address', () => {
    const failure = sendFailureOf(
      new InternalError(
        { reason: 'SENDGRID_SEND_FAILED' },
        { status: 400, body: { errors: [{ message: 'bad address nobody@example.com' }] } },
      ),
    );

    expect(JSON.stringify(failure)).not.toContain('nobody@example.com');
  });
});

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  MAIL_PROVIDER_NOT_CONFIGURED,
  isMailProviderFailure,
  mailRefusalOf,
} from '@providers/mail/index.js';
import { postToSendGrid, refusalOf } from '@providers/mail/sendgrid/sendGridClient.js';
import { AppError, InternalError } from '@utils/errors.js';

import { rejectedBy } from '../../../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../../../helpers/fetchStub.js';

// the part the two streams of mail share: the request to SendGrid with the key of the stream, and
// its refusals and silences told in our words. What each stream sends is tested with its sender
// (sendEmail.helper.test.ts, sendNewsletterEmail.test.ts)

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const payload = { subject: 'Hello' };

const detailsOf = (err: unknown) => (err as AppError).details as Record<string, unknown>;
const causeOf = (err: unknown) => (err as AppError).cause as Record<string, unknown>;

describe('postToSendGrid', () => {
  it('posts the payload as json with the key it is given', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    expect(await postToSendGrid('SG.some-key', payload)).toEqual({});

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://api.sendgrid.com/v3/mail/send',
      method: 'POST',
      headers: { authorization: 'Bearer SG.some-key', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  });

  // the events of the webhook name a mail by this id
  it('gives back the id SendGrid gave the mail, when it gave one', async () => {
    stubFetch(
      () => new Response(null, { status: 202, headers: { 'x-message-id': 'abc.filter0001' } }),
    );

    expect(await postToSendGrid('SG.some-key', payload)).toEqual({ messageId: 'abc.filter0001' });
  });

  it.each([
    ['none', undefined],
    ['an empty one', ''],
  ])('gives back no id when SendGrid gave %s', async (_what, id) => {
    stubFetch(
      () =>
        new Response(null, {
          status: 202,
          headers: id === undefined ? {} : { 'x-message-id': id },
        }),
    );

    expect(await postToSendGrid('SG.some-key', payload)).toEqual({});
  });

  it.each([
    [400, 'refused'],
    [413, 'refused'],
    [401, 'account'],
    [403, 'account'],
    [429, 'busy'],
    [500, 'busy'],
    [503, 'busy'],
  ])('tells a refusal with %i as a refusal of whose fault is %s', async (status, failure) => {
    stubFetch(() => jsonResponse({ errors: [{ message: 'no' }] }, status));

    const err = await rejectedBy(() => postToSendGrid('SG.some-key', payload));

    expect(err).toBeInstanceOf(InternalError);
    expect(detailsOf(err)).toEqual({ reason: 'MAIL_PROVIDER_REFUSED', failure });
    // what SendGrid answered stays in the cause, never in the details
    expect(causeOf(err)).toEqual({ status, body: { errors: [{ message: 'no' }] } });
  });

  it('keeps an answer that is not json as its text', async () => {
    stubFetch(() => textResponse('Bad Gateway', 502));

    const err = await rejectedBy(() => postToSendGrid('SG.some-key', payload));

    expect(causeOf(err)).toEqual({ status: 502, body: 'Bad Gateway' });
  });

  it('tells no answer at all as the provider out of reach', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const err = await rejectedBy(() => postToSendGrid('SG.some-key', payload));

    expect(detailsOf(err)).toEqual({ reason: 'MAIL_PROVIDER_UNREACHABLE' });
  });
});

describe('refusalOf', () => {
  it.each([
    [200, 'busy'],
    [302, 'busy'],
    [404, 'refused'],
    [422, 'refused'],
  ])('tells %i as %s', (status, failure) => {
    expect(refusalOf(status)).toBe(failure);
  });
});

describe('isMailProviderFailure', () => {
  it('counts a refusal of the provider as a provider failure', async () => {
    stubFetch(() => jsonResponse({ errors: [] }, 500));
    const err = await rejectedBy(() => postToSendGrid('SG.some-key', payload));

    expect(isMailProviderFailure(err)).toBe(true);
    expect(mailRefusalOf(err)).toBe('busy');
  });

  it('counts no answer from the provider as a provider failure', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const err = await rejectedBy(() => postToSendGrid('SG.some-key', payload));

    expect(isMailProviderFailure(err)).toBe(true);
    expect(mailRefusalOf(err)).toBeNull();
  });

  it.each(['EMAIL_TO_REQUIRED', 'EMAIL_FROM_REQUIRED', MAIL_PROVIDER_NOT_CONFIGURED])(
    'does not count our own mistake (%s) as a provider failure',
    (reason) => {
      expect(isMailProviderFailure(new InternalError({ reason }))).toBe(false);
      expect(mailRefusalOf(new InternalError({ reason }))).toBeNull();
    },
  );

  it('does not count an error that is not an app error as a provider failure', () => {
    expect(isMailProviderFailure(new Error('MAIL_PROVIDER_REFUSED'))).toBe(false);
  });
});

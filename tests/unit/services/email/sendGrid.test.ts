import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { isEmailProviderFailure, postToSendGrid } from '@services/email/sendGrid.js';
import { InternalError } from '@utils/errors.js';

import { rejectedBy } from '../../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../../helpers/fetchStub.js';

// the part the mails of the orders and the newsletters share: the request to SendGrid with the key of
// the stream, and the telling of a failure of the provider from a mistake of ours. What each stream
// sends is tested with its sender (sendEmail.helper.test.ts, sendNewsletterEmail.test.ts)

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const payload = { subject: 'Hello' };

describe('postToSendGrid', () => {
  it('posts the payload as json with the key it is given and gives back the status', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    expect(await postToSendGrid('SG.some-key', payload)).toEqual({ status: 202 });

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

    expect(await postToSendGrid('SG.some-key', payload)).toEqual({
      status: 202,
      messageId: 'abc.filter0001',
    });
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

    expect(await postToSendGrid('SG.some-key', payload)).toEqual({ status: 202 });
  });
});

describe('isEmailProviderFailure', () => {
  it('counts a refusal of sendgrid as a provider failure', async () => {
    stubFetch(() => jsonResponse({ errors: [] }, 500));
    const err = await rejectedBy(() => postToSendGrid('SG.some-key', payload));

    expect(isEmailProviderFailure(err)).toBe(true);
  });

  it('counts no answer from sendgrid as a provider failure', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const err = await rejectedBy(() => postToSendGrid('SG.some-key', payload));

    expect(isEmailProviderFailure(err)).toBe(true);
  });

  it.each(['EMAIL_TO_REQUIRED', 'EMAIL_FROM_REQUIRED', 'SENDGRID_NEWSLETTER_API_KEY_REQUIRED'])(
    'does not count our own mistake (%s) as a provider failure',
    (reason) => {
      expect(isEmailProviderFailure(new InternalError({ reason }))).toBe(false);
    },
  );

  it('does not count an error that is not an app error as a provider failure', () => {
    expect(isEmailProviderFailure(new Error('SENDGRID_SEND_FAILED'))).toBe(false);
  });
});

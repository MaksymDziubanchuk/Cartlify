import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { rejectedBy } from '../../../../../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../../../../../helpers/fetchStub.js';
import { importWithEnv } from '../../../../../../helpers/freshImport.js';

type Mailer = typeof import('@routes/api/auth/services/helpers/sendEmail.helper.js');
type SendEmailInput =
  import('@routes/api/auth/services/helpers/sendEmail.helper.js').SendEmailInput;

const SPECIFIER = '@routes/api/auth/services/helpers/sendEmail.helper.js';

// synthetic mail settings, the module reads them at import
const CONFIG = {
  SENDGRID_API_KEY: 'SG.test-sendgrid-key',
  EMAIL_FROM: 'shop@cartlify.test',
  EMAIL_FROM_NAME: '',
  EMAIL_REPLY_TO: 'help@cartlify.test',
};

const message: SendEmailInput = {
  to: '  buyer@cartlify.test ',
  subject: ' Your order ',
  text: ' Thank you! ',
};

let mailer: Mailer;

beforeAll(async () => {
  mailer = await importWithEnv<Mailer>(SPECIFIER, CONFIG);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const sentPayload = (body: string) => JSON.parse(body) as Record<string, any>;

describe('sendEmail', () => {
  it.each(['SENDGRID_API_KEY', 'EMAIL_FROM', 'EMAIL_REPLY_TO'])(
    'refuses to send without %s and calls nobody',
    async (key) => {
      const unconfigured = await importWithEnv<Mailer>(SPECIFIER, { ...CONFIG, [key]: '' });
      const calls = stubFetch(() => textResponse('', 202));

      expect(await rejectedBy(() => unconfigured.sendEmail(message))).toMatchObject({
        statusCode: 500,
        details: { reason: `${key}_REQUIRED` },
      });
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    ['address', { to: '  ' }, 'EMAIL_TO_REQUIRED'],
    ['subject', { subject: '' }, 'EMAIL_SUBJECT_REQUIRED'],
    ['text', { text: ' \n ' }, 'EMAIL_TEXT_REQUIRED'],
  ])('refuses a mail without an %s as a server error', async (_case, patch, reason) => {
    const calls = stubFetch(() => textResponse('', 202));

    // the address comes from the database, subject and text from a template: our bug
    expect(await rejectedBy(() => mailer.sendEmail({ ...message, ...patch }))).toMatchObject({
      statusCode: 500,
      details: { reason },
    });
    expect(calls).toHaveLength(0);
  });

  describe('isEmailProviderFailure', () => {
    it('counts a refusal of sendgrid as a provider failure', async () => {
      stubFetch(() => jsonResponse({ errors: [] }, 500));
      const err = await rejectedBy(() => mailer.sendEmail(message));

      expect(mailer.isEmailProviderFailure(err)).toBe(true);
    });

    it('counts no answer from sendgrid as a provider failure', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      const err = await rejectedBy(() => mailer.sendEmail(message));

      expect(mailer.isEmailProviderFailure(err)).toBe(true);
    });

    it('does not count an empty address as a provider failure', async () => {
      stubFetch(() => textResponse('', 202));
      const err = await rejectedBy(() => mailer.sendEmail({ ...message, to: '' }));

      expect(mailer.isEmailProviderFailure(err)).toBe(false);
    });

    it('does not count a missing setting as a provider failure', async () => {
      const unconfigured = await importWithEnv<Mailer>(SPECIFIER, { ...CONFIG, EMAIL_FROM: '' });
      const err = await rejectedBy(() => unconfigured.sendEmail(message));

      expect(unconfigured.isEmailProviderFailure(err)).toBe(false);
    });
  });

  it('does not count an error that is not an app error as a provider failure', () => {
    expect(mailer.isEmailProviderFailure(new Error('SENDGRID_SEND_FAILED'))).toBe(false);
  });

  it('posts the mail to sendgrid with our key and gives back its status', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    expect(await mailer.sendEmail(message)).toEqual({ status: 202 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://api.sendgrid.com/v3/mail/send',
      method: 'POST',
      headers: {
        authorization: `Bearer ${CONFIG.SENDGRID_API_KEY}`,
        'content-type': 'application/json',
      },
    });
  });

  it('sends trimmed fields from our address, with replies going to support', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    await mailer.sendEmail(message);

    expect(sentPayload(calls[0]!.body)).toMatchObject({
      personalizations: [{ to: [{ email: 'buyer@cartlify.test' }] }],
      from: { email: CONFIG.EMAIL_FROM, name: 'Cartlify' },
      reply_to: { email: CONFIG.EMAIL_REPLY_TO, name: 'Cartlify' },
      subject: 'Your order',
      content: [
        { type: 'text/plain', value: 'Thank you!' },
        { type: 'text/html', value: '<p>Thank you!</p>' },
      ],
    });
  });

  // links in transactional mail carry one-time tokens, tracking would rewrite them
  it('turns click and open tracking off', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    await mailer.sendEmail(message);

    expect(sentPayload(calls[0]!.body).tracking_settings).toEqual({
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
    });
  });

  it('escapes the text when it builds the html part itself', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    await mailer.sendEmail({ ...message, text: '<b>Tom & Jerry</b>' });

    expect(sentPayload(calls[0]!.body).content[1].value).toBe(
      '<p>&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;</p>',
    );
  });

  it('keeps html it was given and the attachments, and leaves out an empty attachment list', async () => {
    const calls = stubFetch(() => textResponse('', 202));
    const logo = { content: 'aGk=', type: 'image/png', filename: 'logo.png', content_id: 'logo' };

    await mailer.sendEmail({ ...message, html: '<h1>Hi</h1>', attachments: [logo] });
    await mailer.sendEmail({ ...message, attachments: [] });

    expect(sentPayload(calls[0]!.body)).toMatchObject({
      content: [{}, { value: '<h1>Hi</h1>' }],
      attachments: [logo],
    });
    expect(sentPayload(calls[1]!.body)).not.toHaveProperty('attachments');
  });

  it('reports a refusal from sendgrid with its status and answer', async () => {
    const answer = { errors: [{ message: 'The from address does not match a verified Sender' }] };
    stubFetch(() => jsonResponse(answer, 403));

    expect(await rejectedBy(() => mailer.sendEmail(message))).toMatchObject({
      statusCode: 500,
      details: { reason: 'SENDGRID_SEND_FAILED' },
      cause: { status: 403, body: answer },
    });
  });

  it('keeps a plain text refusal too', async () => {
    stubFetch(() => textResponse('Service Unavailable', 503));

    expect(await rejectedBy(() => mailer.sendEmail(message))).toMatchObject({
      cause: { status: 503, body: 'Service Unavailable' },
    });
  });

  it('keeps an empty refusal as an empty text', async () => {
    stubFetch(
      () => new Response('', { status: 401, headers: { 'content-type': 'application/json' } }),
    );

    expect(await rejectedBy(() => mailer.sendEmail(message))).toMatchObject({
      cause: { status: 401, body: '' },
    });
  });

  // the raw text is what tells why the provider refused
  it('keeps the raw text of a refusal that says json but is not', async () => {
    stubFetch(
      () =>
        new Response('{"errors": [', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    expect(await rejectedBy(() => mailer.sendEmail(message))).toMatchObject({
      cause: { status: 400, body: '{"errors": [' },
    });
  });

  it('reports a network failure', async () => {
    const failure = new TypeError('fetch failed');
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(failure);

    expect(await rejectedBy(() => mailer.sendEmail(message))).toMatchObject({
      statusCode: 500,
      details: { reason: 'SENDGRID_REQUEST_FAILED' },
      cause: failure,
    });
  });

  it('gives up after 7 seconds without an answer', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
          );
        }),
    );

    let settled = false;
    const sending = mailer.sendEmail(message).finally(() => {
      settled = true;
    });
    sending.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(6999);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(await rejectedBy(() => sending)).toMatchObject({
      details: { reason: 'SENDGRID_REQUEST_FAILED' },
    });
  });

  it('leaves no timer behind after an answer', async () => {
    jest.useFakeTimers();
    stubFetch(() => textResponse('', 202));

    await mailer.sendEmail(message);

    expect(jest.getTimerCount()).toBe(0);
  });
});

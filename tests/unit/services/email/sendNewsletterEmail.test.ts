import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { rejectedBy } from '../../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../../helpers/fetchStub.js';
import { importWithEnv } from '../../../helpers/freshImport.js';

type Sender = typeof import('@services/email/sendNewsletterEmail.js');
type Input = import('@services/email/sendNewsletterEmail.js').SendNewsletterEmailInput;

const SPECIFIER = '@services/email/sendNewsletterEmail.js';

// synthetic settings, the modules read them at import. The two streams have a key and a sender each
const CONFIG = {
  SENDGRID_API_KEY: 'SG.key-of-the-orders',
  EMAIL_FROM: 'orders@cartlify.test',
  SENDGRID_NEWSLETTER_API_KEY: 'SG.key-of-the-newsletters',
  NEWSLETTER_EMAIL_FROM: 'news@mail.cartlify.test',
};

// the data of the shop, read at request time. The name of the sender of the orders is another one than
// the name of the newsletters, and the reply address is there: the newsletters take the first and
// never the second
const SETTINGS = {
  shopName: 'Cartlify',
  emailFromName: 'Cartlify Orders Desk',
  newsletterFromName: 'Cartlify News',
  emailReplyTo: 'help@cartlify.test',
};

const message: Input = {
  to: '  anna@cartlify.test ',
  subject: ' Spring offers ',
  text: ' See what is new. ',
};

let sender: Sender;

beforeAll(async () => {
  sender = await importWithEnv<Sender>(SPECIFIER, CONFIG, { shopSettings: SETTINGS });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const sentPayload = (body: string) => JSON.parse(body) as Record<string, any>;

describe('sendNewsletterEmail', () => {
  it.each([
    ['SENDGRID_NEWSLETTER_API_KEY', 'SENDGRID_NEWSLETTER_API_KEY_REQUIRED'],
    ['NEWSLETTER_EMAIL_FROM', 'NEWSLETTER_EMAIL_FROM_REQUIRED'],
  ])('refuses to send without %s and calls nobody', async (key, reason) => {
    const unconfigured = await importWithEnv<Sender>(
      SPECIFIER,
      { ...CONFIG, [key]: '' },
      { shopSettings: SETTINGS },
    );
    const calls = stubFetch(() => textResponse('', 202));

    expect(await rejectedBy(() => unconfigured.sendNewsletterEmail(message))).toMatchObject({
      statusCode: 500,
      details: { reason },
    });
    expect(calls).toHaveLength(0);
  });

  // the keys of the orders are the other stream's: a newsletter must not go out when only they are set
  it('does not fall back to the key or the sender of the orders', async () => {
    const onlyOrders = await importWithEnv<Sender>(
      SPECIFIER,
      { ...CONFIG, SENDGRID_NEWSLETTER_API_KEY: '', NEWSLETTER_EMAIL_FROM: '' },
      { shopSettings: SETTINGS },
    );
    const calls = stubFetch(() => textResponse('', 202));

    await rejectedBy(() => onlyOrders.sendNewsletterEmail(message));

    expect(calls).toHaveLength(0);
  });

  it.each([
    ['address', { to: '  ' }, 'EMAIL_TO_REQUIRED'],
    ['subject', { subject: '' }, 'EMAIL_SUBJECT_REQUIRED'],
    ['text', { text: ' \n ' }, 'EMAIL_TEXT_REQUIRED'],
  ])('refuses a mail without an %s as a server error', async (_case, patch, reason) => {
    const calls = stubFetch(() => textResponse('', 202));

    expect(
      await rejectedBy(() => sender.sendNewsletterEmail({ ...message, ...patch })),
    ).toMatchObject({ statusCode: 500, details: { reason } });
    expect(calls).toHaveLength(0);
  });

  it('posts the mail to sendgrid with the key of the newsletters and gives back its status', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    expect(await sender.sendNewsletterEmail(message)).toEqual({ status: 202 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://api.sendgrid.com/v3/mail/send',
      method: 'POST',
      headers: {
        authorization: `Bearer ${CONFIG.SENDGRID_NEWSLETTER_API_KEY}`,
        'content-type': 'application/json',
      },
    });
  });

  it('sends trimmed fields from the sender of the newsletters, under the name root gave them', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    await sender.sendNewsletterEmail(message);

    expect(sentPayload(calls[0]!.body)).toMatchObject({
      personalizations: [{ to: [{ email: 'anna@cartlify.test' }] }],
      from: { email: CONFIG.NEWSLETTER_EMAIL_FROM, name: 'Cartlify News' },
      subject: 'Spring offers',
      content: [
        { type: 'text/plain', value: 'See what is new.' },
        { type: 'text/html', value: '<p>See what is new.</p>' },
      ],
    });
  });

  // The name of the sender is newsletterFromName; while root left it empty it is the name of the
  // mails of the orders (emailFromName), and while that is empty too, the name of the shop. The sender
  // address is the address of the stream whatever the name is
  describe('the name of the sender', () => {
    const nameWith = async (settings: Record<string, string>) => {
      const named = await importWithEnv<Sender>(SPECIFIER, CONFIG, {
        shopSettings: { ...SETTINGS, ...settings },
      });
      const calls = stubFetch(() => textResponse('', 202));

      await named.sendNewsletterEmail(message);

      return sentPayload(calls[0]!.body).from as { email: string; name: string };
    };

    it.each([
      [
        'the name of the newsletters, while there is one',
        { newsletterFromName: 'Cartlify News', emailFromName: 'Orders', shopName: 'Shop' },
        'Cartlify News',
      ],
      [
        'the name of the mails of the orders, while the newsletters have none',
        { newsletterFromName: '', emailFromName: 'Orders', shopName: 'Shop' },
        'Orders',
      ],
      [
        'the name of the shop, while neither has one',
        { newsletterFromName: '', emailFromName: '', shopName: 'Shop' },
        'Shop',
      ],
      [
        'the name of the newsletters even when the others are there',
        { newsletterFromName: 'Only news', emailFromName: '', shopName: 'Shop' },
        'Only news',
      ],
      [
        'the name of the orders, when the name of the newsletters is blank',
        { newsletterFromName: '   ', emailFromName: 'Orders', shopName: 'Shop' },
        'Orders',
      ],
      [
        'the name of the shop, when the names of both streams are blank',
        { newsletterFromName: ' ', emailFromName: '  ', shopName: 'Shop' },
        'Shop',
      ],
    ])('is %s', async (_what, settings, name) => {
      expect(await nameWith(settings)).toEqual({ email: CONFIG.NEWSLETTER_EMAIL_FROM, name });
    });

    it('is the name as root wrote it, with the spaces cut at its ends', async () => {
      expect((await nameWith({ newsletterFromName: '  Cartlify  News ' })).name).toBe(
        'Cartlify  News',
      );
    });

    it('is read at each mail: root changes it while the server runs', async () => {
      const named = await importWithEnv<Sender>(SPECIFIER, CONFIG, { shopSettings: SETTINGS });
      // the copy of the data of the shop that the sender just read
      const { setShopSettingsForTest } = await import('@config/shopSettings.js');
      const calls = stubFetch(() => textResponse('', 202));

      await named.sendNewsletterEmail(message);
      setShopSettingsForTest({ newsletterFromName: 'Changed' });
      await named.sendNewsletterEmail(message);

      expect(calls.map((call) => sentPayload(call.body).from.name)).toEqual([
        'Cartlify News',
        'Changed',
      ]);
    });
  });

  // the answers go to an address that drops them: no Reply-To, so no reader to write to
  it('sends no Reply-To, not even the reply address of the orders', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    await sender.sendNewsletterEmail(message);
    await sender.sendNewsletterEmail({
      ...message,
      headers: { 'List-Unsubscribe': '<https://x.test/u>' },
    });

    for (const call of calls) {
      expect(sentPayload(call.body)).not.toHaveProperty('reply_to');
      expect(call.body.toLowerCase()).not.toContain('reply');
      expect(call.body).not.toContain(SETTINGS.emailReplyTo);
    }
  });

  it('never carries the key or the sender of the orders', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    await sender.sendNewsletterEmail(message);

    expect(JSON.stringify(calls[0]!.headers)).not.toContain(CONFIG.SENDGRID_API_KEY);
    expect(calls[0]!.body).not.toContain(CONFIG.EMAIL_FROM);
    expect(calls[0]!.body).not.toContain(SETTINGS.emailFromName);
  });

  it('puts the mail in the category newsletter, for the lists of its stream', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    await sender.sendNewsletterEmail(message);

    expect(sentPayload(calls[0]!.body).categories).toEqual(['newsletter']);
  });

  // the links of the mail are ours to read: SendGrid does not rewrite them, count them, or add a
  // footer and a link of its own to unsubscribe
  it('turns every kind of tracking off on the mail itself', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    await sender.sendNewsletterEmail(message);

    expect(sentPayload(calls[0]!.body).tracking_settings).toEqual({
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
      ganalytics: { enable: false },
    });
  });

  describe('headers and custom arguments', () => {
    it('sends the headers it is given, for the one-click unsubscribe', async () => {
      const calls = stubFetch(() => textResponse('', 202));
      const headers = {
        'List-Unsubscribe': '<https://api.cartlify.test/api/newsletters/unsubscribe/abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };

      await sender.sendNewsletterEmail({ ...message, headers });

      expect(sentPayload(calls[0]!.body).headers).toEqual(headers);
    });

    it('sends the custom arguments it is given, which come back in the events of the webhook', async () => {
      const calls = stubFetch(() => textResponse('', 202));

      await sender.sendNewsletterEmail({
        ...message,
        customArgs: { campaignId: '12', recipientId: '345' },
      });

      expect(sentPayload(calls[0]!.body).custom_args).toEqual({
        campaignId: '12',
        recipientId: '345',
      });
    });

    it('leaves both out when it has none, or an empty object', async () => {
      const calls = stubFetch(() => textResponse('', 202));

      await sender.sendNewsletterEmail(message);
      await sender.sendNewsletterEmail({ ...message, headers: {}, customArgs: {} });

      for (const call of calls) {
        const payload = sentPayload(call.body);
        expect(payload).not.toHaveProperty('headers');
        expect(payload).not.toHaveProperty('custom_args');
      }
    });

    it.each([
      ['Reply-To', 'a@b.test'],
      ['reply-to', 'a@b.test'],
      ['  Reply-To ', 'a@b.test'],
    ])('refuses the header %j, there is no Reply-To in this stream', async (name, value) => {
      const calls = stubFetch(() => textResponse('', 202));

      expect(
        await rejectedBy(() =>
          sender.sendNewsletterEmail({ ...message, headers: { [name]: value } }),
        ),
      ).toMatchObject({ statusCode: 500, details: { reason: 'NEWSLETTER_HEADER_FORBIDDEN' } });
      expect(calls).toHaveLength(0);
    });

    it.each([
      ['a name with a space', 'List Unsubscribe', 'x'],
      ['a name with a colon', 'List-Unsubscribe:', 'x'],
      ['an empty name', '', 'x'],
      ['a value with a line break', 'X-Test', 'a\r\nBcc: someone@else.test'],
      ['a value with a line feed', 'X-Test', 'a\nb'],
    ])('refuses a header with %s', async (_case, name, value) => {
      const calls = stubFetch(() => textResponse('', 202));

      expect(
        await rejectedBy(() =>
          sender.sendNewsletterEmail({ ...message, headers: { [name]: value } }),
        ),
      ).toMatchObject({ statusCode: 500, details: { reason: 'NEWSLETTER_HEADER_INVALID' } });
      expect(calls).toHaveLength(0);
    });
  });

  it('escapes the text when it builds the html part itself', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    await sender.sendNewsletterEmail({ ...message, text: '<b>Tom & Jerry</b>' });

    expect(sentPayload(calls[0]!.body).content[1].value).toBe(
      '<p>&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;</p>',
    );
  });

  // the logo is shown by its address in the html: a mail of the stream carries no attachment
  it('keeps the html it was given and sends no attachment', async () => {
    const calls = stubFetch(() => textResponse('', 202));

    await sender.sendNewsletterEmail({ ...message, html: '<h1>Hi</h1>' });

    expect(sentPayload(calls[0]!.body)).toMatchObject({
      content: [{}, { value: '<h1>Hi</h1>' }],
    });
    expect(sentPayload(calls[0]!.body)).not.toHaveProperty('attachments');
  });

  describe('when SendGrid does not take the mail', () => {
    it('reports a refusal with its status and answer', async () => {
      const answer = { errors: [{ message: 'The from address does not match a verified Sender' }] };
      stubFetch(() => jsonResponse(answer, 403));

      expect(await rejectedBy(() => sender.sendNewsletterEmail(message))).toMatchObject({
        statusCode: 500,
        details: { reason: 'SENDGRID_SEND_FAILED' },
        cause: { status: 403, body: answer },
      });
    });

    it('reports a network failure', async () => {
      const failure = new TypeError('fetch failed');
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(failure);

      expect(await rejectedBy(() => sender.sendNewsletterEmail(message))).toMatchObject({
        statusCode: 500,
        details: { reason: 'SENDGRID_REQUEST_FAILED' },
        cause: failure,
      });
    });

    it('gives up after 7 seconds without an answer, like the mails of the orders', async () => {
      jest.useFakeTimers();
      jest.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
              ),
            );
          }),
      );

      let settled = false;
      const sending = sender.sendNewsletterEmail(message).finally(() => {
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

    // the callers tell a failure of the provider (a bad gateway) from our own mistake, for both streams
    it('fails the way the mails of the orders do, so isEmailProviderFailure reads it', async () => {
      // one registry for the sender and the check: the errors are classes of that copy of the modules
      const fresh = await importWithEnv<Sender>(SPECIFIER, CONFIG, { shopSettings: SETTINGS });
      const { isEmailProviderFailure } = await import('@services/email/sendGrid.js');
      stubFetch(() => jsonResponse({ errors: [] }, 500));

      const failure = await rejectedBy(() => fresh.sendNewsletterEmail(message));
      stubFetch(() => textResponse('', 202));
      const own = await rejectedBy(() => fresh.sendNewsletterEmail({ ...message, to: '' }));

      expect(isEmailProviderFailure(failure)).toBe(true);
      expect(isEmailProviderFailure(own)).toBe(false);
    });
  });
});

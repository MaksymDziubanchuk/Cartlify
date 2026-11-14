import { beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import { loadShopSettings } from '@config/shopSettings.js';
import { mailProvider } from '@providers/mail/index.js';
import { isAppError } from '@utils/errors.js';

import { rejectedBy } from '../../helpers/errors.js';
import { mailHarness } from '../../helpers/providers.js';

import type { OutgoingMail } from '@providers/mail/index.js';

// The contract of a mail provider: what the rest of the app counts on, whoever sends the mails
// (src/providers/mail/types.ts). The provider of the server goes through these tests, made to answer
// by its entry in tests/helpers/providers.ts (its mock, or the real service when the run takes it);
// another provider passes them without tests of its own.

const harness = mailHarness[mailProvider.name];
const silentLog = { warn: () => undefined };

beforeAll(async () => {
  await loadShopSettings();
});

// a mail of the newsletter stream, from its sender (a provider takes a mail only from the sender
// the account of the stream has verified)
const mailTo = (to: string, over: Partial<OutgoingMail> = {}): OutgoingMail => ({
  to,
  from: { email: env.NEWSLETTER_EMAIL_FROM, name: 'Contract shop' },
  subject: 'Contract test',
  text: 'A mail of the contract test.',
  html: '<p>A mail of the contract test.</p>',
  ...over,
});

const detailsOf = (err: unknown) =>
  isAppError(err) ? (err.details as Record<string, unknown>) : { thrown: String(err) };

describe(`the mail provider ${mailProvider.name}`, () => {
  describe('sends', () => {
    it('a mail of each stream, from the sender of the stream, and gives its id', async () => {
      const orders = harness.watch('orders');
      const news = harness.watch('newsletter');

      const sent = await mailProvider.send('newsletter', mailTo('reader@example.com'));
      await mailProvider.send(
        'orders',
        mailTo('buyer@example.com', { from: { email: env.EMAIL_FROM, name: 'Shop' } }),
      );

      expect(sent.messageId).toEqual(expect.any(String));
      expect(news()).toEqual(['reader@example.com']);
      expect(orders()).toEqual(['buyer@example.com']);
    });

    it.each(['refused', 'account', 'busy'] as const)(
      'tells a refusal that is the fault of %s in our words',
      async (failure) => {
        harness.answerNewsletter(failure);

        const err = await rejectedBy(() =>
          mailProvider.send('newsletter', mailTo('r@example.com')),
        );

        expect(detailsOf(err)).toEqual({ reason: 'MAIL_PROVIDER_REFUSED', failure });
      },
    );

    it('tells no answer as the provider out of reach', async () => {
      harness.answerNewsletter('unreachable');

      const err = await rejectedBy(() => mailProvider.send('newsletter', mailTo('r@example.com')));

      expect(detailsOf(err)).toEqual({ reason: 'MAIL_PROVIDER_UNREACHABLE' });
    });

    it.each(['orders', 'newsletter'] as const)(
      'refuses to send the stream %s without its key, and says it has none',
      async (stream) => {
        const err = await harness.withoutKey(stream, async () => {
          expect(mailProvider.isConfigured(stream)).toBe(false);
          return rejectedBy(() =>
            mailProvider.send(
              stream,
              mailTo('r@example.com', {
                from: {
                  email: stream === 'orders' ? env.EMAIL_FROM : env.NEWSLETTER_EMAIL_FROM,
                  name: 'Shop',
                },
              }),
            ),
          );
        });

        expect(detailsOf(err)).toEqual({ reason: 'MAIL_PROVIDER_NOT_CONFIGURED', stream });
        expect(mailProvider.isConfigured(stream)).toBe(true);
      },
    );
  });

  describe('takes an address off the list of complaints', () => {
    it('and says so', async () => {
      const cleared = harness.watchCleared();

      expect(await mailProvider.clearComplaint('Reader@Example.com', silentLog)).toBe(true);
      expect(cleared()).toEqual(['reader@example.com']);
    });

    it('or says it could not, without throwing', async () => {
      harness.breakClearing();

      expect(await mailProvider.clearComplaint('reader@example.com', silentLog)).toBe(false);
    });
  });

  describe('its webhook', () => {
    const tags = { campaignId: '5', recipientId: '9', environment: 'test' };

    it('takes a batch it signed, and tells its events in our words with their tags', () => {
      const events = [
        harness.eventOf('bounced', tags),
        harness.otherEvent(tags),
        harness.eventOf('dropped', tags),
        harness.eventOf('dropped', tags, 'address_bounced'),
        harness.eventOf('dropped', tags, 'address_complained'),
        harness.eventOf('complained', tags),
      ];
      const request = harness.signed(events);

      expect(mailProvider.webhook.check(request)).toEqual({ verdict: 'valid' });

      const reading = mailProvider.webhook.readEvents(JSON.parse(request.rawBody.toString('utf8')));

      expect(reading).toEqual({
        events: [
          { kind: 'bounced', dropReason: null, tags: expect.objectContaining(tags) },
          { kind: 'dropped', dropReason: null, tags: expect.objectContaining(tags) },
          { kind: 'dropped', dropReason: 'address_bounced', tags: expect.objectContaining(tags) },
          {
            kind: 'dropped',
            dropReason: 'address_complained',
            tags: expect.objectContaining(tags),
          },
          { kind: 'complained', dropReason: null, tags: expect.objectContaining(tags) },
        ],
        ignored: 1,
        invalid: 0,
      });
    });

    it('refuses a batch somebody else signed, or one changed after it was signed', () => {
      const events = [harness.eventOf('bounced', tags)];
      const changed = harness.signed(events);
      changed.rawBody = Buffer.from(JSON.stringify([harness.eventOf('complained', tags)]));

      expect(mailProvider.webhook.check(harness.signedByAnother(events))).toMatchObject({
        verdict: 'invalid',
      });
      expect(mailProvider.webhook.check(changed)).toMatchObject({ verdict: 'invalid' });
    });

    it('tells a batch without a signature apart', () => {
      expect(mailProvider.webhook.check(harness.unsigned([]))).toEqual({ verdict: 'missing' });
    });

    it.each([[{}], ['text'], [5], [null]])('reads no batch of events in the body %j', (body) => {
      expect(mailProvider.webhook.readEvents(body)).toBeNull();
    });

    it('counts an item that is no event', () => {
      expect(mailProvider.webhook.readEvents([null, 'text'])).toEqual({
        events: [],
        ignored: 0,
        invalid: 2,
      });
    });

    it('asks for its headers and keeps a body within its limit', () => {
      expect(mailProvider.webhook.headers).toMatchObject({ type: 'object' });
      expect(mailProvider.webhook.bodyLimit).toBeGreaterThan(0);
      expect(mailProvider.webhook.description).toEqual(expect.any(String));
    });
  });
});

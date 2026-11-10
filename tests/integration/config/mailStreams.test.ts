import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { clearSpamReport } from '@services/email/clearSpamReport.js';
import { sendNewsletterEmail } from '@services/email/sendNewsletterEmail.js';

import { startApp, stopApp } from '../../helpers/app.js';
import {
  breakSpamReportClearing,
  refuseMail,
  watchMail,
  watchNewsletterMail,
  watchSpamReportClearing,
} from '../../helpers/mail.js';
import { resetShopSettings, setShopSettings } from '../../helpers/shopSettings.js';

// The two streams of mail the app has: the orders (SENDGRID_API_KEY, EMAIL_FROM) and the newsletters
// (SENDGRID_NEWSLETTER_API_KEY, NEWSLETTER_EMAIL_FROM), two accounts of SendGrid with lists of
// their own. The mock of SendGrid of the tests (tests/helpers/mail.ts) tells them apart by the key
// and by the sender it sees, and takes a mail only when the two belong together, the way SendGrid
// refuses a sender that is not verified for the key's account. These tests hold the mock to that,
// and the senders to the right key and sender

const NEWSLETTER_SENDER = process.env.NEWSLETTER_EMAIL_FROM!;
const NEWSLETTER_KEY = process.env.SENDGRID_NEWSLETTER_API_KEY!;
const SEND_URL = 'https://api.sendgrid.com/v3/mail/send';

beforeAll(async () => {
  await startApp();
});

afterAll(async () => {
  await stopApp();
});

afterEach(() => resetShopSettings());

const order = { to: 'buyer@example.com', subject: 'Order paid', text: 'Thank you.' };
const newsletter = { to: 'reader@example.com', subject: 'Spring offers', text: 'See what is new.' };

describe('the sender of the newsletters', () => {
  it('goes through the newsletter stream with the newsletter sender, and not through the orders', async () => {
    const news = watchNewsletterMail();
    const orders = watchMail();

    await sendNewsletterEmail(newsletter);

    expect(orders).toHaveLength(0);
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({
      stream: 'newsletter',
      to: ['reader@example.com'],
      subject: 'Spring offers',
      from: NEWSLETTER_SENDER,
      accepted: true,
      status: 202,
    });
    expect(news[0]!.from).not.toBe(env.EMAIL_FROM);
  });

  it('sends no Reply-To, names the sender after the shop and tags the category and the stream tracking', async () => {
    const news = watchNewsletterMail();

    await sendNewsletterEmail(newsletter);

    expect(news[0]).toMatchObject({
      replyTo: null,
      fromName: expect.any(String),
      categories: ['newsletter'],
      tracking: {
        click_tracking: { enable: false },
        open_tracking: { enable: false },
        subscription_tracking: { enable: false },
        ganalytics: { enable: false },
      },
    });
    expect(news[0]!.fromName).not.toBe('');
  });

  // root names the sender of the newsletters (newsletterFromName); without it the sender has the name of
  // the mails of the orders, and without that the name of the shop. The orders keep their own name
  it('names the sender after newsletterFromName, then emailFromName, then the name of the shop', async () => {
    const news = watchNewsletterMail();
    const orders = watchMail();

    setShopSettings({ newsletterFromName: 'Cartlify News', emailFromName: 'Cartlify Orders' });
    await sendNewsletterEmail(newsletter);
    setShopSettings({ newsletterFromName: '', emailFromName: 'Cartlify Orders' });
    await sendNewsletterEmail(newsletter);
    setShopSettings({ newsletterFromName: '', emailFromName: '', shopName: 'Linen & Co' });
    await sendNewsletterEmail(newsletter);
    await sendEmail(order);

    expect(news.map((mail) => mail.fromName)).toEqual([
      'Cartlify News',
      'Cartlify Orders',
      'Linen & Co',
    ]);
    // the stream of the orders does not take the name of the newsletters
    expect(orders[0]!.fromName).toBe('Linen & Co');
  });

  it('keeps the headers and the custom arguments for the unsubscribe and the events', async () => {
    const news = watchNewsletterMail();

    await sendNewsletterEmail({
      ...newsletter,
      headers: {
        'List-Unsubscribe': '<https://api.example.com/api/newsletters/unsubscribe/abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      customArgs: { campaignId: '7', recipientId: '42' },
    });

    expect(news[0]).toMatchObject({
      headers: {
        'List-Unsubscribe': '<https://api.example.com/api/newsletters/unsubscribe/abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      customArgs: { campaignId: '7', recipientId: '42' },
    });
  });

  // the logo is shown by its address in the html: a mail of this stream carries no attachment
  it('sends no attachment with the mail', async () => {
    const news = watchNewsletterMail();

    await sendNewsletterEmail({ ...newsletter, html: '<p>Hi</p>' });

    expect(news[0]!.attachments).toEqual([]);
  });
});

describe('the sender of the orders', () => {
  it('goes through the orders stream with the orders sender, and not through the newsletters', async () => {
    const news = watchNewsletterMail();
    const orders = watchMail();

    await sendEmail(order);

    expect(news).toHaveLength(0);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      stream: 'orders',
      to: ['buyer@example.com'],
      from: env.EMAIL_FROM,
      accepted: true,
    });
    expect(orders[0]!.from).not.toBe(NEWSLETTER_SENDER);
  });

  it('still sends its Reply-To, which the newsletters do without', async () => {
    const orders = watchMail();

    await sendEmail(order);

    expect(orders[0]!.replyTo).toBeTruthy();
    expect(orders[0]!.categories).toEqual([]);
  });
});

// a request that puts the key of one stream with the sender of the other is refused by the mock
// the way SendGrid refuses a sender its account has not verified, so a mix-up in the app fails
describe('the mock of SendGrid', () => {
  const post = (key: string, from: string) =>
    fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: 'reader@example.com' }] }],
        from: { email: from },
        subject: 'Hello',
        content: [{ type: 'text/plain', value: 'Hello' }],
      }),
    });

  it('refuses the newsletter key with the sender of the orders', async () => {
    const news = watchNewsletterMail();

    const res = await post(NEWSLETTER_KEY, env.EMAIL_FROM);

    expect(res.status).toBe(403);
    expect(news).toMatchObject([{ stream: 'newsletter', accepted: false, status: 403 }]);
  });

  it('refuses the key of the orders with the sender of the newsletters', async () => {
    const orders = watchMail();

    const res = await post(env.SENDGRID_API_KEY, NEWSLETTER_SENDER);

    expect(res.status).toBe(403);
    expect(orders).toMatchObject([{ stream: 'orders', accepted: false, status: 403 }]);
  });

  it('takes each key with its own sender', async () => {
    expect((await post(NEWSLETTER_KEY, NEWSLETTER_SENDER)).status).toBe(202);
    // the orders go to SendGrid itself in sandbox mode when the run takes the real service
    expect((await post(env.SENDGRID_API_KEY, env.EMAIL_FROM)).ok).toBe(true);
  });

  it('refuses the mails of one stream or of both, as asked, until the test ends', async () => {
    refuseMail('newsletter');
    await expect(sendNewsletterEmail(newsletter)).rejects.toMatchObject({
      details: { reason: 'SENDGRID_SEND_FAILED' },
    });
    await expect(sendEmail(order)).resolves.toBeDefined();
  });

  it('no longer refuses in the next test, and refuses both streams when asked for none', async () => {
    await expect(sendNewsletterEmail(newsletter)).resolves.toMatchObject({ status: 202 });

    refuseMail();
    await expect(sendNewsletterEmail(newsletter)).rejects.toBeDefined();
    await expect(sendEmail(order)).rejects.toBeDefined();
  });
});

describe('the clearing of a spam report', () => {
  it('calls SendGrid with the newsletter key, for the address as it was mailed to', async () => {
    const calls = watchSpamReportClearing();
    const warnings: unknown[] = [];

    expect(
      await clearSpamReport('  Reader@Example.COM ', {
        warn: (obj: unknown) => void warnings.push(obj),
      }),
    ).toBe(true);

    expect(calls).toEqual([{ email: 'reader@example.com', stream: 'newsletter', status: 204 }]);
    expect(warnings).toEqual([]);
  });

  it('is answered 403 for the key of the orders, which is not the account that holds the list', async () => {
    const calls = watchSpamReportClearing();

    const res = await fetch(
      'https://api.sendgrid.com/v3/suppression/spam_reports/reader%40example.com',
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}` },
      },
    );

    expect(res.status).toBe(403);
    expect(calls).toEqual([{ email: 'reader@example.com', stream: 'orders', status: 403 }]);
  });

  it.each(['refused', 'unreachable'] as const)(
    'turns false and warns when SendGrid is %s, without throwing',
    async (kind) => {
      const calls = watchSpamReportClearing();
      const warnings: unknown[] = [];
      breakSpamReportClearing(kind);

      expect(
        await clearSpamReport('reader@example.com', {
          warn: (obj: unknown) => void warnings.push(obj),
        }),
      ).toBe(false);

      expect(warnings).toHaveLength(1);
      expect(calls).toHaveLength(kind === 'refused' ? 1 : 0);
      expect(JSON.stringify(warnings)).not.toContain('reader');
      expect(JSON.stringify(warnings)).not.toContain(NEWSLETTER_KEY);
    },
  );

  it('works again in the next test', async () => {
    expect(await clearSpamReport('reader@example.com', { warn: () => undefined })).toBe(true);
  });
});

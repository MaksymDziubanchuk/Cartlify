import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { SendEmailInput } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import type { ShopLogoAttachment } from '@services/email/shopLogo.js';

// the provider is replaced: what the mail says is tested on the template, here only what goes out.
// shopLogo.js is replaced too: whether it finds a logo or not is its own test (shopLogo.test.ts),
// here only whether this helper wires what it gives into the mail
const sendEmail = jest.fn<(input: SendEmailInput) => Promise<{ status: number }>>();
const shopLogoAttachment = jest.fn<(log: unknown) => Promise<ShopLogoAttachment | null>>();

jest.unstable_mockModule('@routes/api/auth/services/helpers/sendEmail.helper.js', () => ({
  sendEmail,
}));
jest.unstable_mockModule('@services/email/shopLogo.js', () => ({
  SHOP_LOGO_CID: 'cartlify-logo',
  shopLogoAttachment,
}));

const { sendAccountDeletedEmail } =
  await import('@routes/api/users/services/helpers/accountDeletedEmail.helper.js');

const log = () => ({ warn: jest.fn(), error: jest.fn() });

const LOGO: ShopLogoAttachment = {
  content: 'aGk=',
  type: 'image/png',
  filename: 'logo.png',
  disposition: 'inline',
  content_id: 'cartlify-logo',
};

const args = {
  userId: 15,
  to: 'anna@example.com',
  userName: 'Anna',
  locale: 'en',
  deliveries: [
    { orderId: 3, status: 'paid' as const, total: '10.00', items: [{ name: 'Lamp', quantity: 1 }] },
  ],
  cancelled: [],
};

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ status: 202 });
  shopLogoAttachment.mockReset();
  shopLogoAttachment.mockResolvedValue(LOGO);
});

describe('sendAccountDeletedEmail', () => {
  it('mails the old address with the logo attached for the html', async () => {
    await sendAccountDeletedEmail(args, log());

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0]![0];
    expect(mail).toMatchObject({
      to: 'anna@example.com',
      subject: 'Cartlify — Your account is deleted',
    });
    expect(mail.text).toContain('Order #3');
    expect(mail.html).toContain('cid:cartlify-logo');
    expect(mail.attachments).toEqual([LOGO]);
  });

  // no logo, or a Cloudinary fetch that failed, is not a reason to refuse the mail
  // (shopLogoAttachment already turned that into null; notes/i18n-shop-steps.md, step 4)
  it('mails the old address without the logo when the shop has none', async () => {
    shopLogoAttachment.mockResolvedValue(null);

    await sendAccountDeletedEmail(args, log());

    const mail = sendEmail.mock.calls[0]![0];
    expect(mail.html).not.toContain('cid:cartlify-logo');
    expect(mail.attachments).toEqual([]);
  });

  // the account is already deleted when the mail goes: a failure must not reach the request
  it('only logs a mail that could not be sent, with the user id and never the address', async () => {
    sendEmail.mockRejectedValue(new Error('provider down'));
    const logger = log();

    await expect(sendAccountDeletedEmail(args, logger)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 15 }),
      'account deleted mail was not sent',
    );
    expect(JSON.stringify(logger.error.mock.calls[0]?.[0] ?? {})).not.toContain('anna@example.com');
  });
});

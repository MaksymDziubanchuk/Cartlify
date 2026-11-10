import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { SendEmailInput } from '@routes/api/auth/services/helpers/sendEmail.helper.js';

import { resetShopSettings, setShopSettings } from '../../../../../../helpers/shopSettings.js';

// the provider is replaced: what the mail says is tested on the template, here only what goes out
const sendEmail = jest.fn<(input: SendEmailInput) => Promise<{ status: number }>>();

jest.unstable_mockModule('@routes/api/auth/services/helpers/sendEmail.helper.js', () => ({
  sendEmail,
}));

const { sendAccountDeletedEmail } =
  await import('@routes/api/users/services/helpers/accountDeletedEmail.helper.js');

const log = () => ({ warn: jest.fn(), error: jest.fn() });

// the logo of the shop is shown by its address at Cloudinary
const LOGO_URL = 'https://res.cloudinary.com/cartlify-test/image/upload/v1/test/shop/logo/a.png';

const args = {
  userId: 15,
  to: 'anna@example.com',
  userName: 'Anna',
  locale: 'en',
  deliveries: [
    { orderId: 3, status: 'paid' as const, total: '10.00', items: [{ name: 'Lamp', quantity: 1 }] },
  ],
  cancelled: [],
  newsletterEnded: false,
};

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ status: 202 });
  setShopSettings({ logoUrl: LOGO_URL });
});

afterEach(() => resetShopSettings());

describe('sendAccountDeletedEmail', () => {
  it('mails the old address with the logo shown by its address, nothing attached', async () => {
    await sendAccountDeletedEmail(args, log());

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0]![0];
    expect(mail).toMatchObject({
      to: 'anna@example.com',
      subject: 'Cartlify — Your account is deleted',
    });
    expect(mail.text).toContain('Order #3');
    expect(mail.html).toContain(`src="${LOGO_URL}"`);
    expect(mail.attachments).toBeUndefined();
  });

  // the sentence about the newsletter goes in the mail exactly when the deletion ended a subscription
  it('tells the person that the subscription to the newsletter was cancelled, only when it was', async () => {
    await sendAccountDeletedEmail({ ...args, newsletterEnded: true }, log());
    await sendAccountDeletedEmail(args, log());

    const [withSentence, without] = sendEmail.mock.calls.map(([mail]) => mail);
    expect(withSentence!.text).toContain(
      'Your newsletter subscription has been cancelled as well.',
    );
    expect(withSentence!.html).toContain(
      'Your newsletter subscription has been cancelled as well.',
    );
    expect(without!.text).not.toContain('newsletter');
    expect(without!.html).not.toContain('newsletter');
  });

  // no logo is not a reason to refuse the mail
  it('mails the old address without the logo when the shop has none', async () => {
    setShopSettings({ logoUrl: null });

    await sendAccountDeletedEmail(args, log());

    const mail = sendEmail.mock.calls[0]![0];
    expect(mail.html).not.toMatch(/<img\b/);
    expect(mail.attachments).toBeUndefined();
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

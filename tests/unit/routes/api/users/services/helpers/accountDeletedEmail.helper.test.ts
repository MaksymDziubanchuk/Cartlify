import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { SendEmailInput } from '@routes/api/auth/services/helpers/sendEmail.helper.js';

// the provider is replaced: what the mail says is tested on the template, here only what goes out
const sendEmail = jest.fn<(input: SendEmailInput) => Promise<{ status: number }>>();

jest.unstable_mockModule('@routes/api/auth/services/helpers/sendEmail.helper.js', () => ({
  sendEmail,
}));

const { sendAccountDeletedEmail } =
  await import('@routes/api/users/services/helpers/accountDeletedEmail.helper.js');

const log = () => ({ warn: jest.fn(), error: jest.fn() });

const args = {
  userId: 15,
  to: 'anna@example.com',
  userName: 'Anna',
  deliveries: [
    { orderId: 3, status: 'paid' as const, total: '10.00', items: [{ name: 'Lamp', quantity: 1 }] },
  ],
  cancelled: [],
};

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ status: 202 });
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
    expect(mail.attachments).toEqual([
      expect.objectContaining({
        content_id: 'cartlify-logo',
        disposition: 'inline',
        type: 'image/png',
      }),
    ]);
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

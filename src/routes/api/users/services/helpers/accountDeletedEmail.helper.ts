import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildAccountDeletedTemplate,
  type AccountDeletedCancelled,
  type AccountDeletedDelivery,
} from '@services/email/templates/users/accountDeleted.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { shopCurrency } from '@routes/api/payments/providers/index.js';

export type AccountDeletionLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type AccountDeletedEmailArgs = {
  userId: number;
  // the address the account had before it was emptied, it lives only until this mail is sent
  to: string;
  userName: string | null;
  deliveries: AccountDeletedDelivery[];
  cancelled: AccountDeletedCancelled[];
};

// mails the person that the account is gone, with the orders still on their way and the orders
// the deletion cancelled. The account is deleted before this runs, so a mail that fails is only
// logged; the log keeps the user id, never the address
export async function sendAccountDeletedEmail(
  args: AccountDeletedEmailArgs,
  log: AccountDeletionLogger,
): Promise<void> {
  try {
    const { subject, text, html } = buildAccountDeletedTemplate({
      deliveries: args.deliveries,
      cancelled: args.cancelled,
      // the orders of the mail are paid or waited for in the money of the shop
      currency: shopCurrency(),
      userName: args.userName,
      logoCid: 'cartlify-logo',
    });

    const logoPath = path.join(process.cwd(), 'src', 'static', 'images', 'logo3.png');
    const logoBase64 = (await readFile(logoPath)).toString('base64');

    await sendEmail({
      to: args.to,
      subject,
      text,
      html,
      attachments: [
        {
          content: logoBase64,
          type: 'image/png',
          filename: 'logo3.png',
          disposition: 'inline',
          content_id: 'cartlify-logo',
        },
      ],
    });
  } catch (err) {
    log.error({ err, userId: args.userId }, 'account deleted mail was not sent');
  }
}

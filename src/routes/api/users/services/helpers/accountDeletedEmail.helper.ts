import env from '@config/env.js';
import {
  buildAccountDeletedTemplate,
  type AccountDeletedCancelled,
  type AccountDeletedDelivery,
} from '@services/email/templates/users/accountDeleted.template.js';
import { sendEmail } from '@routes/api/auth/services/helpers/sendEmail.helper.js';
import { shopCurrency } from '@routes/api/payments/providers/index.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';

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
      // the name of the shop the mail is from
      appName: env.SHOP_NAME,
      deliveries: args.deliveries,
      cancelled: args.cancelled,
      // the orders of the mail are paid or waited for in the money of the shop
      currency: shopCurrency(),
      userName: args.userName,
      logoCid: SHOP_LOGO_CID,
    });

    await sendEmail({
      to: args.to,
      subject,
      text,
      html,
      attachments: [await shopLogoAttachment()],
    });
  } catch (err) {
    log.error({ err, userId: args.userId }, 'account deleted mail was not sent');
  }
}

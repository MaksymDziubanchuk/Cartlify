import env from '@config/env.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { buildPasswordChangedTemplate } from '@services/email/templates/auth/passwordChanged.template.js';

import { sendEmail } from './sendEmail.helper.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';

export type SendPasswordChangedEmailArgs = {
  to: string;
  changedAt: Date;
  userName?: string;
};

// tells the owner the password changed: a person who did not change it learns of it and resets it
export async function sendPasswordChangedEmail(
  args: SendPasswordChangedEmailArgs,
): Promise<{ status: number }> {
  const { subject, text, html } = buildPasswordChangedTemplate({
    loginUrl: webPageUrl(env.WEB_PAGE_LOGIN),
    changedAt: args.changedAt,
    userName: args.userName || '',
    appName: env.SHOP_NAME,
    logoCid: SHOP_LOGO_CID,
  });

  return sendEmail({
    to: args.to,
    subject,
    text,
    html,
    attachments: [await shopLogoAttachment()],
  });
}

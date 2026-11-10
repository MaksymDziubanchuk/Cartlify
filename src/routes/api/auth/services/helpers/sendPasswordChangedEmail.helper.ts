import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { buildPasswordChangedTemplate } from '@services/email/templates/auth/passwordChanged.template.js';

import { sendEmail } from './sendEmail.helper.js';

export type SendPasswordChangedEmailArgs = {
  to: string;
  changedAt: Date;
  userName?: string;
  locale?: string;
};

// tells the owner the password changed: a person who did not change it learns of it and resets it
export async function sendPasswordChangedEmail(
  args: SendPasswordChangedEmailArgs,
): Promise<{ status: number }> {
  const { subject, text, html } = buildPasswordChangedTemplate({
    loginUrl: webPageUrl(env.WEB_PAGE_LOGIN),
    changedAt: args.changedAt,
    userName: args.userName || '',
    appName: shopSettings().shopName,
    logoUrl: shopSettings().logoUrl,
    ...(args.locale ? { locale: args.locale } : {}),
  });

  return sendEmail({
    to: args.to,
    subject,
    text,
    html,
  });
}

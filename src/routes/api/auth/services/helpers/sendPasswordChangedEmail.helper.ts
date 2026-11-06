import type { FastifyBaseLogger } from 'fastify';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { buildPasswordChangedTemplate } from '@services/email/templates/auth/passwordChanged.template.js';

import { sendEmail } from './sendEmail.helper.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';

export type SendPasswordChangedEmailArgs = {
  to: string;
  changedAt: Date;
  userName?: string;
  locale?: string;
};

// tells the owner the password changed: a person who did not change it learns of it and resets it
export async function sendPasswordChangedEmail(
  args: SendPasswordChangedEmailArgs,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<{ status: number }> {
  const logo = await shopLogoAttachment(log);

  const { subject, text, html } = buildPasswordChangedTemplate({
    loginUrl: webPageUrl(env.WEB_PAGE_LOGIN),
    changedAt: args.changedAt,
    userName: args.userName || '',
    appName: shopSettings().shopName,
    ...(logo ? { logoCid: SHOP_LOGO_CID } : {}),
    ...(args.locale ? { locale: args.locale } : {}),
  });

  return sendEmail({
    to: args.to,
    subject,
    text,
    html,
    attachments: logo ? [logo] : [],
  });
}

import type { FastifyBaseLogger } from 'fastify';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { isEmailProviderFailure, sendEmail } from './sendEmail.helper.js';
import { buildVerifyEmailTemplate } from '@services/email/templates/auth/verifyEmail.template.js';
import { AppError } from '@utils/errors.js';
import { formatExpiresIn } from '@helpers/formatExpiresIn.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { SHOP_LOGO_CID, shopLogoAttachment } from '@services/email/shopLogo.js';

export type SendVerifyEmailArgs = {
  to: string;
  token: string;
  expiresAt: Date;
  userName?: string;
  locale?: string;
};

// build verify url
// add expiry hint
// send email via provider
export async function sendVerifyEmail(
  args: SendVerifyEmailArgs,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<{ status: number }> {
  const verifyUrl = buildWebLoginVerifyUrl(args.token);
  const expiresInText = formatExpiresIn(args.expiresAt, args.locale);
  const logo = await shopLogoAttachment(log);

  const { subject, text, html } = buildVerifyEmailTemplate({
    verifyUrl,
    userName: args.userName || '',
    appName: shopSettings().shopName,
    ...(logo ? { logoCid: SHOP_LOGO_CID } : {}),
    ...(args.locale ? { locale: args.locale } : {}),
    expiresInText,
  });

  try {
    return await sendEmail({
      to: args.to,
      subject,
      text,
      html,
      attachments: logo ? [logo] : [],
    });
  } catch (err) {
    // only a failure of the mail provider is a bad gateway, our own error stays a server error
    if (!isEmailProviderFailure(err)) throw err;

    // avoid leaking provider details
    throw new AppError({
      statusCode: 502,
      errorCode: 'VERIFY_EMAIL_SEND_FAILED',
      message: 'Bad Gateway',
      cause: err,
    });
  }
}

// frontend verify entrypoint (WEB_PAGE_VERIFY_EMAIL)
// a mail from production must link to the live site, a localhost link opens nothing there
function buildWebLoginVerifyUrl(token: string): string {
  return webPageUrl(env.WEB_PAGE_VERIFY_EMAIL, { query: { token } });
}

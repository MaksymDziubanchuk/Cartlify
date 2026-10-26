import env from '@config/env.js';
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
};

// build verify url
// add expiry hint
// send email via provider
export async function sendVerifyEmail(args: SendVerifyEmailArgs): Promise<{ status: number }> {
  const verifyUrl = buildWebLoginVerifyUrl(args.token);
  const expiresInText = formatExpiresIn(args.expiresAt);

  const { subject, text, html } = buildVerifyEmailTemplate({
    verifyUrl,
    userName: args.userName || '',
    appName: env.SHOP_NAME,
    logoCid: SHOP_LOGO_CID,
    expiresInText,
  });

  try {
    return await sendEmail({
      to: args.to,
      subject,
      text,
      html,
      attachments: [await shopLogoAttachment()],
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

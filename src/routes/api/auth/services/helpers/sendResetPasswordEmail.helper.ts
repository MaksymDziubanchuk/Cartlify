import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { AppError } from '@utils/errors.js';
import { formatExpiresIn } from '@helpers/formatExpiresIn.js';
import { webPageUrl } from '@helpers/webOrigin.js';

import { sendEmail } from './sendEmail.helper.js';
import { isEmailProviderFailure } from '@services/email/sendGrid.js';
import { buildResetPasswordTemplate } from '@services/email/templates/auth/resetPassword.template.js';

export type SendResetPasswordEmailArgs = {
  to: string;
  resetToken: string;
  expiresAt: Date;
  userName?: string;
  locale?: string;
};

// reset email main flow
// build reset url
// send branded email
export async function sendResetPasswordEmail(
  args: SendResetPasswordEmailArgs,
): Promise<{ status: number }> {
  const resetUrl = buildWebResetUrl(args.resetToken);
  const expiresInText = formatExpiresIn(args.expiresAt, args.locale);

  const { subject, text, html } = buildResetPasswordTemplate({
    resetUrl,
    userName: args.userName || '',
    appName: shopSettings().shopName,
    logoUrl: shopSettings().logoUrl,
    ...(args.locale ? { locale: args.locale } : {}),
    expiresInText,
  });

  try {
    return await sendEmail({
      to: args.to,
      subject,
      text,
      html,
    });
  } catch (err) {
    // only a failure of the mail provider is a bad gateway, our own error stays a server error
    if (!isEmailProviderFailure(err)) throw err;

    throw new AppError({
      statusCode: 502,
      errorCode: 'RESET_EMAIL_SEND_FAILED',
      message: 'Bad Gateway',
      cause: err,
    });
  }
}

// frontend reset entrypoint (WEB_PAGE_PASSWORD_RESET)
// a mail from production must link to the live site, a localhost link opens nothing there.
// The token follows the # (no server sees a fragment, so no log holds the token); the page reads it
// and posts it with the new password to POST /api/auth/password/reset
function buildWebResetUrl(token: string): string {
  return webPageUrl(env.WEB_PAGE_PASSWORD_RESET, { fragment: { token } });
}

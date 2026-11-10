import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { sendEmail } from './sendEmail.helper.js';
import { isEmailProviderFailure } from '@services/email/sendGrid.js';
import { buildVerifyEmailTemplate } from '@services/email/templates/auth/verifyEmail.template.js';
import { AppError } from '@utils/errors.js';
import { formatExpiresIn } from '@helpers/formatExpiresIn.js';
import { webPageUrl } from '@helpers/webOrigin.js';

export type SendVerifyEmailArgs = {
  to: string;
  token: string;
  expiresAt: Date;
  userName?: string;
  locale?: string;
  // the box of the newsletter the registration form ticked: the link carries it as a hint for the
  // page that confirms the email. A mail sent again does not know it and carries none
  newsletter?: boolean;
};

// build verify url
// add expiry hint
// send email via provider
export async function sendVerifyEmail(args: SendVerifyEmailArgs): Promise<{ status: number }> {
  const verifyUrl = buildWebLoginVerifyUrl(args.token, args.newsletter === true);
  const expiresInText = formatExpiresIn(args.expiresAt, args.locale);

  const { subject, text, html } = buildVerifyEmailTemplate({
    verifyUrl,
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
// a mail from production must link to the live site, a localhost link opens nothing there.
// The token follows the # (no server sees a fragment, so no log holds the token); the page reads it
// and posts it to POST /api/auth/verify. newsletter=1 is only a hint for the page (the box of the
// form was ticked); what counts is the choice the page sends with the token
function buildWebLoginVerifyUrl(token: string, newsletter: boolean): string {
  return webPageUrl(env.WEB_PAGE_VERIFY_EMAIL, {
    fragment: { token, ...(newsletter ? { newsletter: '1' } : {}) },
  });
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import env from '@config/env.js';
import { AppError, InternalError } from '@utils/errors.js';
import { formatExpiresIn } from '@helpers/formatExpiresIn.js';

import { isEmailProviderFailure, sendEmail } from './sendEmail.helper.js';
import { buildResetPasswordTemplate } from '@services/email/templates/resetPassword.template.js';

export type SendResetPasswordEmailArgs = {
  to: string;
  resetToken: string;
  expiresAt: Date;
  userName?: string;
};

// reset email main flow
// build reset url
// send branded email
export async function sendResetPasswordEmail(
  args: SendResetPasswordEmailArgs,
): Promise<{ status: number }> {
  const resetUrl = buildWebResetUrl(args.resetToken);
  const expiresInText = formatExpiresIn(args.expiresAt);

  const logoPath = path.join(process.cwd(), 'src', 'static', 'images', 'logo3.png');
  const logoBase64 = (await readFile(logoPath)).toString('base64');

  const { subject, text, html } = buildResetPasswordTemplate({
    resetUrl,
    userName: args.userName || '',
    appName: 'Cartlify',
    logoCid: 'cartlify-logo',
    expiresInText,
  });

  try {
    return await sendEmail({
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

// frontend reset entrypoint
function buildWebResetUrl(token: string): string {
  const origin = (env.WEB_ORIGIN || '').trim();

  // a mail from production must link to the live site, a localhost link opens nothing there
  if (!origin && env.NODE_ENV === 'production') {
    throw new InternalError({ reason: 'WEB_ORIGIN_REQUIRED' });
  }

  const url = new URL('/web/auth/reset', origin || 'http://localhost:3000');
  url.searchParams.set('token', token);
  return url.toString();
}

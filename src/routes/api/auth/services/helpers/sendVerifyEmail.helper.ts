import env from '@config/env.js';
import { isEmailProviderFailure, sendEmail } from './sendEmail.helper.js';
import { buildVerifyEmailTemplate } from '@services/email/templates/auth/verifyEmail.template.js';
import { AppError } from '@utils/errors.js';
import { formatExpiresIn } from '@helpers/formatExpiresIn.js';
import { webUrl } from '@helpers/webOrigin.js';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

  const logoPath = path.join(process.cwd(), 'src', 'static', 'images', 'logo3.png');
  const logoBase64 = (await readFile(logoPath)).toString('base64');

  const { subject, text, html } = buildVerifyEmailTemplate({
    verifyUrl,
    userName: args.userName || '',
    appName: env.SHOP_NAME,
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

    // avoid leaking provider details
    throw new AppError({
      statusCode: 502,
      errorCode: 'VERIFY_EMAIL_SEND_FAILED',
      message: 'Bad Gateway',
      cause: err,
    });
  }
}

// frontend verify entrypoint
// a mail from production must link to the live site, a localhost link opens nothing there
function buildWebLoginVerifyUrl(token: string): string {
  return webUrl('/web/login', { token });
}

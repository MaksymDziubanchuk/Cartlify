import { readFile } from 'node:fs/promises';
import path from 'node:path';

import env from '@config/env.js';
import { AppError } from '@utils/errors.js';

import { sendEmail } from './sendEmail.helper.js';
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
  } catch {
    throw new AppError('RESET_EMAIL_SEND_FAILED', 502);
  }
}

// frontend reset entrypoint
function buildWebResetUrl(token: string): string {
  const base = (env.WEB_ORIGIN || '').trim() || 'http://localhost:3000';
  const url = new URL('/web/auth/reset', base);
  url.searchParams.set('token', token);
  return url.toString();
}

// human ttl message
function formatExpiresIn(expiresAt: Date): string {
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return '0 minutes';

  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes} minutes`;

  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} hours`;

  const days = Math.ceil(hours / 24);
  return `${days} days`;
}

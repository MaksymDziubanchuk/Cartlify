import { readFile } from 'node:fs/promises';
import path from 'node:path';

import env from '@config/env.js';
import { webUrl } from '@helpers/webOrigin.js';
import { buildPasswordChangedTemplate } from '@services/email/templates/auth/passwordChanged.template.js';

import { sendEmail } from './sendEmail.helper.js';

export type SendPasswordChangedEmailArgs = {
  to: string;
  changedAt: Date;
  userName?: string;
};

// tells the owner the password changed: a person who did not change it learns of it and resets it
export async function sendPasswordChangedEmail(
  args: SendPasswordChangedEmailArgs,
): Promise<{ status: number }> {
  const logoPath = path.join(process.cwd(), 'src', 'static', 'images', 'logo3.png');
  const logoBase64 = (await readFile(logoPath)).toString('base64');

  const { subject, text, html } = buildPasswordChangedTemplate({
    loginUrl: webUrl('/web/login'),
    changedAt: args.changedAt,
    userName: args.userName || '',
    appName: env.SHOP_NAME,
    logoCid: 'cartlify-logo',
  });

  return sendEmail({
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
}

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { InternalError } from '@utils/errors.js';
import { postToSendGrid } from '@services/email/sendGrid.js';
import { escapeHtml } from '@helpers/escapeHtml.js';

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  // files that go with the mail (the terms and the contract of a paid order); the logo is not one
  // of them, the html shows it by its address
  attachments?: Array<{
    content: string; // base64
    type: string; // e.g. "text/plain"
    filename: string;
    disposition?: 'attachment';
  }>;
};

// transactional email main flow
// build provider payload
// map provider errors to app
export async function sendEmail(input: SendEmailInput): Promise<{ status: number }> {
  // require email config
  if (!env.SENDGRID_API_KEY) throw new InternalError({ reason: 'SENDGRID_API_KEY_REQUIRED' });
  if (!env.EMAIL_FROM) throw new InternalError({ reason: 'EMAIL_FROM_REQUIRED' });
  const settings = shopSettings();
  if (!settings.emailReplyTo) throw new InternalError({ reason: 'EMAIL_REPLY_TO_REQUIRED' });

  const to = input.to?.trim();
  const subject = input.subject?.trim();
  const text = input.text?.trim();

  // validate email request: the address comes from the database, subject and text from a
  // template, so an empty one is a server bug, not a bad request
  if (!to) throw new InternalError({ reason: 'EMAIL_TO_REQUIRED' });
  if (!subject) throw new InternalError({ reason: 'EMAIL_SUBJECT_REQUIRED' });
  if (!text) throw new InternalError({ reason: 'EMAIL_TEXT_REQUIRED' });

  const html = input.html?.trim() || `<p>${escapeHtml(text)}</p>`;

  // prepare provider payload
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: env.EMAIL_FROM, name: settings.emailFromName || settings.shopName },
    reply_to: { email: settings.emailReplyTo, name: settings.emailFromName || settings.shopName },
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: html },
    ],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
    },
    attachments: input.attachments?.length ? input.attachments : undefined,
  };

  // send via provider api, errors mapped by the shared core
  return postToSendGrid(env.SENDGRID_API_KEY, payload);
}

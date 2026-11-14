import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { escapeHtml } from '@helpers/escapeHtml.js';
import { mailProvider } from '@providers/mail/index.js';
import { InternalError } from '@utils/errors.js';

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
  }>;
};

// A mail of the stream of the orders and the accounts: its own key at the mail provider and its
// sender (EMAIL_FROM), the answers go to the address root set (emailReplyTo). Errors are the ones of
// the provider (src/providers/mail/types.ts)
export async function sendEmail(input: SendEmailInput): Promise<{ messageId?: string }> {
  // require email config
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

  const name = settings.emailFromName || settings.shopName;

  return mailProvider.send('orders', {
    to,
    from: { email: env.EMAIL_FROM, name },
    replyTo: { email: settings.emailReplyTo, name },
    subject,
    text,
    html: input.html?.trim() || `<p>${escapeHtml(text)}</p>`,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  });
}

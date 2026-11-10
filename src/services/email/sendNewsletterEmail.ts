import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { escapeHtml } from '@helpers/escapeHtml.js';
import { InternalError } from '@utils/errors.js';
import { postToSendGrid } from '@services/email/sendGrid.js';

// The SendGrid category of every mail of this stream: the lists of complaints, bounces and
// unsubscribes of the newsletter account are kept per account, the category tells the mails apart
// in its statistics
export const NEWSLETTER_CATEGORY = 'newsletter';

export type SendNewsletterEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  // extra headers of the mail itself: List-Unsubscribe and List-Unsubscribe-Post of a newsletter
  headers?: Record<string, string>;
  // what comes back with every event of the webhook for this mail (the campaign and the recipient)
  customArgs?: Record<string, string>;
};

// a header the stream never sets: there is no Reply-To, the answers go to an address that drops them
const FORBIDDEN_HEADERS = new Set(['reply-to']);
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

// the headers as SendGrid takes them: a name of letters, digits and hyphens, a value on one line,
// and not the Reply-To this stream does without
function checkedHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const given = Object.entries(headers ?? {});

  for (const [rawName, value] of given) {
    const name = rawName.trim();
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new InternalError({ reason: 'NEWSLETTER_HEADER_FORBIDDEN' });
    }
    if (!HEADER_NAME.test(name) || /[\r\n]/.test(value)) {
      throw new InternalError({ reason: 'NEWSLETTER_HEADER_INVALID' });
    }
  }

  return Object.fromEntries(given.map(([name, value]) => [name.trim(), value]));
}

// The name the newsletters are sent under: the name root gave them (newsletterFromName), else the name
// of the mails of the orders (emailFromName), else the name of the shop. A name of spaces is no name
function senderNameOf(): string {
  const settings = shopSettings();

  return settings.newsletterFromName.trim() || settings.emailFromName.trim() || settings.shopName;
}

// A mail of the newsletter stream: its own SendGrid key (SENDGRID_NEWSLETTER_API_KEY) and sender
// (NEWSLETTER_EMAIL_FROM, named senderNameOf), so the complaints about newsletters stay on their
// account and subdomain and do not touch the mails of the orders. No Reply-To, the category
// "newsletter", and every kind of tracking off on the mail itself: the links are ours and SendGrid
// must not rewrite them or add a footer. Errors are the ones of the orders' stream (sendGrid.ts).
export async function sendNewsletterEmail(
  input: SendNewsletterEmailInput,
): Promise<{ status: number; messageId?: string }> {
  // require the config of the stream, never the key or the sender of the orders
  if (!env.SENDGRID_NEWSLETTER_API_KEY) {
    throw new InternalError({ reason: 'SENDGRID_NEWSLETTER_API_KEY_REQUIRED' });
  }
  if (!env.NEWSLETTER_EMAIL_FROM)
    throw new InternalError({ reason: 'NEWSLETTER_EMAIL_FROM_REQUIRED' });

  const to = input.to?.trim();
  const subject = input.subject?.trim();
  const text = input.text?.trim();

  // the address comes from the database, subject and text from a template: an empty one is a
  // server bug, not a bad request
  if (!to) throw new InternalError({ reason: 'EMAIL_TO_REQUIRED' });
  if (!subject) throw new InternalError({ reason: 'EMAIL_SUBJECT_REQUIRED' });
  if (!text) throw new InternalError({ reason: 'EMAIL_TEXT_REQUIRED' });

  const headers = checkedHeaders(input.headers);
  const html = input.html?.trim() || `<p>${escapeHtml(text)}</p>`;

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: env.NEWSLETTER_EMAIL_FROM, name: senderNameOf() },
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: html },
    ],
    categories: [NEWSLETTER_CATEGORY],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
      ganalytics: { enable: false },
    },
    headers: Object.keys(headers).length ? headers : undefined,
    custom_args: Object.keys(input.customArgs ?? {}).length ? input.customArgs : undefined,
  };

  return postToSendGrid(env.SENDGRID_NEWSLETTER_API_KEY, payload);
}

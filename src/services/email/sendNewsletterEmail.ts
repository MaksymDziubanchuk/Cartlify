import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { escapeHtml } from '@helpers/escapeHtml.js';
import { mailProvider } from '@providers/mail/index.js';
import { InternalError } from '@utils/errors.js';

// the category of every mail of this stream at the mail provider: the lists of complaints, bounces
// and unsubscribes of the newsletter account are kept per account, the category tells the mails
// apart in its statistics
export const NEWSLETTER_CATEGORY = 'newsletter';

export type SendNewsletterEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  // extra headers of the mail itself: List-Unsubscribe and List-Unsubscribe-Post of a newsletter
  headers?: Record<string, string>;
  // what comes back with every event of the webhook for this mail (the campaign and the recipient)
  tags?: Record<string, string>;
};

// a header the stream never sets: there is no Reply-To, the answers go to an address that drops them
const FORBIDDEN_HEADERS = new Set(['reply-to']);
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

// the headers as a mail takes them: a name of letters, digits and hyphens, a value on one line,
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

// A mail of the newsletter stream: its own account at the mail provider and its own sender
// (NEWSLETTER_EMAIL_FROM, named senderNameOf), so the complaints about newsletters stay on their
// account and subdomain and do not touch the mails of the orders. No Reply-To and the category
// "newsletter". Errors are the ones of the provider (src/providers/mail/types.ts).
export async function sendNewsletterEmail(
  input: SendNewsletterEmailInput,
): Promise<{ messageId?: string }> {
  // the sender of the stream, never the one of the orders
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

  return mailProvider.send('newsletter', {
    to,
    from: { email: env.NEWSLETTER_EMAIL_FROM, name: senderNameOf() },
    subject,
    text,
    html: input.html?.trim() || `<p>${escapeHtml(text)}</p>`,
    category: NEWSLETTER_CATEGORY,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(Object.keys(input.tags ?? {}).length ? { tags: input.tags! } : {}),
  });
}

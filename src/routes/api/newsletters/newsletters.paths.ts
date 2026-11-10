// the address SendGrid posts the events of the mails of the newsletters to (the Event Webhook of the
// account, set in its settings): the route lives under it, and the request rate limit leaves it
// alone (src/helpers/rateLimitFree.ts), as it leaves the webhooks of the payment providers
export const SENDGRID_WEBHOOK_PATH = '/api/newsletters/sendgrid/webhook';

// the unsubscribe button of the mails (the POST of a mail client and the GET of the link) has the
// token in the path, one segment after this. The request rate limit leaves it alone too and the button
// keeps only its own count (LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS): a mailbox provider unsubscribes
// a crowd of readers from a few addresses. The rate limit reads a real address, the swagger document
// the pattern of the route (`:token`); both are one segment
const UNSUBSCRIBE_PATH_PREFIX = '/api/newsletters/unsubscribe/';

export function isUnsubscribeButtonPath(path: string): boolean {
  if (!path.startsWith(UNSUBSCRIBE_PATH_PREFIX)) return false;
  const token = path.slice(UNSUBSCRIBE_PATH_PREFIX.length);
  return token.length > 0 && !token.includes('/');
}

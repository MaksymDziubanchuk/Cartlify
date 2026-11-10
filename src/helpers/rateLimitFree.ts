import {
  isUnsubscribeButtonPath,
  SENDGRID_WEBHOOK_PATH,
} from '@routes/api/newsletters/newsletters.paths.js';
import { PAYMENT_CALLBACK_PATHS } from '@routes/api/payments/providers/index.js';

// the addresses the rate limit does not count: the health checks of the host, the events of
// payment providers (a provider delivers every event from a few addresses: a busy hour of sales
// would hit the limit and hold back payments already made), the Event Webhook of the mail
// provider (the same: bounces and complaints held back would keep mails going to dead addresses)
// and the unsubscribe button of the mails (a mailbox provider unsubscribes a crowd of readers from
// a few addresses; the button has a count of its own, wide on purpose).
// The signature keeps anybody else out of the webhooks, so only the exact paths, not every path that
// starts like one. The rate limit and the swagger document read the same rule
export function isRateLimitFree(url: string): boolean {
  const path = url.split('?')[0] ?? '';

  return (
    path.startsWith('/health') ||
    path.startsWith('/ready') ||
    PAYMENT_CALLBACK_PATHS.has(path) ||
    path === SENDGRID_WEBHOOK_PATH ||
    isUnsubscribeButtonPath(path)
  );
}

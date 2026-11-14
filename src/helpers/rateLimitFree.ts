import { PROVIDER_CALLBACK_PATHS } from '@providers/callbackPaths.js';
import { isUnsubscribeButtonPath } from '@routes/api/newsletters/newsletters.paths.js';

// the addresses the rate limit does not count: the health checks of the host, the events of the
// providers of the outside services (a provider delivers every event from a few addresses: a busy
// hour of sales would hit the limit and hold back payments already made, bounces and complaints held
// back would keep mails going to dead addresses) and the unsubscribe button of the mails (a mailbox
// provider unsubscribes a crowd of readers from a few addresses; the button has a count of its own,
// wide on purpose).
// The signature keeps anybody else out of the webhooks, so only the exact paths, not every path that
// starts like one. The rate limit and the swagger document read the same rule
export function isRateLimitFree(url: string): boolean {
  const path = url.split('?')[0] ?? '';

  return (
    path.startsWith('/health') ||
    path.startsWith('/ready') ||
    PROVIDER_CALLBACK_PATHS.has(path) ||
    isUnsubscribeButtonPath(path)
  );
}

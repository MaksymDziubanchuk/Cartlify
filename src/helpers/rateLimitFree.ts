import { PAYMENT_CALLBACK_PATHS } from '@routes/api/payments/providers/index.js';

// the addresses the rate limit does not count: the health checks of the host, static files, and
// the events of payment providers (a provider delivers every event from a few addresses: a busy
// hour of sales would hit the limit and hold back payments already made; the signature keeps
// anybody else out, so only the exact paths of the providers, not every path that starts like
// one). The rate limit and the swagger document read the same rule
export function isRateLimitFree(url: string): boolean {
  const path = url.split('?')[0] ?? '';

  return (
    path.startsWith('/health') ||
    path.startsWith('/ready') ||
    path.startsWith('/static') ||
    PAYMENT_CALLBACK_PATHS.has(path)
  );
}

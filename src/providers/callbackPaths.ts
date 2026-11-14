import { MAIL_WEBHOOK_PATH } from './mail/index.js';
import { PAYMENT_CALLBACK_PATHS } from './payments/index.js';

// the paths the providers of the outside services call the server on (the events of the payments,
// of the mails): a provider delivers every event from a few addresses, so the request rate limit
// leaves them alone (src/helpers/rateLimitFree.ts); the signature keeps anybody else out
export const PROVIDER_CALLBACK_PATHS: ReadonlySet<string> = new Set([
  ...PAYMENT_CALLBACK_PATHS,
  MAIL_WEBHOOK_PATH,
]);

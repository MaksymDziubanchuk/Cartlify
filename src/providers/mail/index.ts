import env from '@config/env.js';
import { AppError } from '@utils/errors.js';

import { pickProvider } from '../provider.js';

import { MAIL_PROVIDER_NAMES } from './names.js';
import { sendGridProvider } from './sendgrid/sendGrid.provider.js';
import {
  MAIL_PROVIDER_REFUSED,
  MAIL_PROVIDER_UNREACHABLE,
  type MailProvider,
  type MailRefusal,
} from './types.js';

export * from './names.js';
export * from './types.js';

// every mail provider this server has; MAIL_PROVIDER names the one it sends with
const providers: readonly MailProvider[] = [sendGridProvider];

// the list the settings take the names from is the list of the providers themselves
if (
  providers.length !== MAIL_PROVIDER_NAMES.length ||
  providers.some((provider, i) => provider.name !== MAIL_PROVIDER_NAMES[i])
) {
  throw new Error('MAIL_PROVIDER_NAMES must name the mail providers in the same order');
}

export const mailProvider: MailProvider = pickProvider(
  'MAIL_PROVIDER',
  env.MAIL_PROVIDER,
  providers,
);

// where the provider reports the events of the mails of the newsletters (the route lives in the
// newsletters, newsletters.webhook.routes.ts); outside the request rate limit
export const MAIL_WEBHOOK_PATH = `/api/newsletters/${mailProvider.name}/webhook`;

const reasonOf = (err: unknown): unknown =>
  err instanceof AppError ? (err.details as { reason?: unknown } | undefined)?.reason : undefined;

// tells a failure of the mail provider (it refused the mail or did not answer: a bad gateway for
// the client) from our own error, like a missing setting, which stays a server error
export function isMailProviderFailure(err: unknown): boolean {
  const reason = reasonOf(err);
  return reason === MAIL_PROVIDER_REFUSED || reason === MAIL_PROVIDER_UNREACHABLE;
}

// whose fault a refusal of the provider is; null for an error that is no refusal
export function mailRefusalOf(err: unknown): MailRefusal | null {
  if (reasonOf(err) !== MAIL_PROVIDER_REFUSED) return null;

  const failure = ((err as AppError).details as { failure?: unknown } | undefined)?.failure;
  return failure === 'refused' || failure === 'account' || failure === 'busy' ? failure : 'busy';
}

import {
  MAIL_PROVIDER_UNREACHABLE,
  isMailProviderFailure,
  mailRefusalOf,
} from '@providers/mail/index.js';
import { AppError } from '@utils/errors.js';

// What a failed send of a newsletter mail means for the pass that sent it:
// - retry: the mail provider is busy or unreachable (no answer in time): the mail stays in the
//   queue and is tried again at a later claim, until its tries are used up;
// - refused: the provider will never take this mail (the fault is the mail's): the recipient is
//   rejected, unless the run of refusals it is in turns out to be the stream's fault
//   (sendRecipient.helper.ts);
// - halt: a problem of the whole stream (the key or the account is refused: account; a setting of
//   the stream is missing; the mail cannot be made): sending more would fail the same way for
//   everyone, so the pass stops and leaves the mails in the queue.
export type SendFailure = {
  kind: 'retry' | 'refused' | 'halt';
  // the provider refused the key or the account of the stream
  account: boolean;
  // the status the provider answered with, if it did
  status: number | null;
  // the reason code of our own error (MAIL_PROVIDER_REFUSED, MAIL_PROVIDER_UNREACHABLE, ...), for
  // the log; never the answer of the provider, which may name the address
  reason: string;
};

const statusOf = (err: unknown): number | null => {
  const cause = err instanceof AppError ? err.cause : undefined;
  const status = (cause as { status?: unknown } | null | undefined)?.status;

  return typeof status === 'number' ? status : null;
};

const reasonOf = (err: unknown): string => {
  const details = err instanceof AppError ? err.details : undefined;
  const reason = (details as { reason?: unknown } | undefined)?.reason;

  return typeof reason === 'string' ? reason : err instanceof AppError ? err.errorCode : 'UNKNOWN';
};

export function sendFailureOf(err: unknown): SendFailure {
  const reason = reasonOf(err);

  // not an answer or a silence of the provider: our own configuration or a bug, the same for every
  // mail
  if (!isMailProviderFailure(err)) return { kind: 'halt', account: false, status: null, reason };

  // no answer in time, or none at all
  if (reason === MAIL_PROVIDER_UNREACHABLE) {
    return { kind: 'retry', account: false, status: null, reason };
  }

  const status = statusOf(err);
  const refusal = mailRefusalOf(err);
  if (refusal === 'account') return { kind: 'halt', account: true, status, reason };
  if (refusal === 'refused') return { kind: 'refused', account: false, status, reason };

  // busy, and anything the provider says that is not a refusal we know
  return { kind: 'retry', account: false, status, reason };
}

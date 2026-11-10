import { isEmailProviderFailure } from '@services/email/sendGrid.js';
import { AppError } from '@utils/errors.js';

// What a failed send of a newsletter mail means for the pass that sent it:
// - retry: SendGrid is busy or unreachable (429, 5xx, no answer in time): the mail stays in the queue
//   and is tried again at a later claim, until its tries are used up;
// - refused: SendGrid will never take this mail (a 4xx that is not about the key or the account): the
//   recipient is rejected, unless the run of refusals it is in turns out to be the stream's fault
//   (sendRecipient.helper.ts);
// - halt: a problem of the whole stream (the key or the account is refused, 401 and 403; a setting of
//   the stream is missing; the mail cannot be made): sending more would fail the same way for everyone,
//   so the pass stops and leaves the mails in the queue.
export type SendFailure = {
  kind: 'retry' | 'refused' | 'halt';
  // the status SendGrid answered with, if it did
  status: number | null;
  // the reason code of our own error (SENDGRID_SEND_FAILED, SENDGRID_REQUEST_FAILED, ...), for the log;
  // never the answer of SendGrid, which may name the address
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

  // not an answer or a silence of SendGrid: our own configuration or a bug, the same for every mail
  if (!isEmailProviderFailure(err)) return { kind: 'halt', status: null, reason };

  // no answer in time, or none at all
  if (reason === 'SENDGRID_REQUEST_FAILED') return { kind: 'retry', status: null, reason };

  const status = statusOf(err);
  if (status === 401 || status === 403) return { kind: 'halt', status, reason };
  if (status !== null && status >= 400 && status < 500 && status !== 429) {
    return { kind: 'refused', status, reason };
  }

  // 429, 5xx, and anything SendGrid says that is not a status we know
  return { kind: 'retry', status, reason };
}

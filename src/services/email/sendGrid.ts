import { AppError, InternalError } from '@utils/errors.js';

// what the two streams of mail have in common (the mails of the orders, src/routes/api/auth/services/
// helpers/sendEmail.helper.ts, and the newsletters, sendNewsletterEmail.ts): the request to SendGrid,
// its time limit and the way a refusal or a silence becomes an error. The key, the sender and the
// content are the business of each stream

export const SENDGRID_MAIL_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';

// how long SendGrid may take to answer before the mail is given up
export const SENDGRID_TIMEOUT_MS = 7000;

// the reasons a send gives when the provider refused or did not answer
const PROVIDER_FAILURE_REASONS = new Set(['SENDGRID_SEND_FAILED', 'SENDGRID_REQUEST_FAILED']);

// tells a failure of the mail provider (a bad gateway for the client) from our own error,
// like a missing setting, which stays a server error
export function isEmailProviderFailure(err: unknown): boolean {
  const reason =
    err instanceof AppError ? (err.details as { reason?: unknown } | undefined)?.reason : undefined;
  return typeof reason === 'string' && PROVIDER_FAILURE_REASONS.has(reason);
}

type AnyJson = Record<string, unknown> | unknown[] | string | number | boolean | null;

// post one mail to SendGrid with the key of its stream and map the provider errors to the app's:
// SENDGRID_SEND_FAILED with the status and the answer when SendGrid refuses, SENDGRID_REQUEST_FAILED
// when it does not answer in time or at all. A mail it takes gets an id (the header X-Message-Id),
// which the events of the webhook name it by
export async function postToSendGrid(
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; messageId?: string }> {
  // bound external call time
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SENDGRID_TIMEOUT_MS);

  try {
    // send via provider api
    const res = await fetch(SENDGRID_MAIL_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    // accept provider delivery
    if (res.ok) {
      const messageId = res.headers.get('x-message-id');
      return messageId ? { status: res.status, messageId } : { status: res.status };
    }

    // capture provider error details; a body can be read only once, so it is read as text
    // and then parsed: a "json" answer that is not json still keeps its raw text
    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text().catch(() => '');
    let body: AnyJson = raw;

    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(raw) as AnyJson;
      } catch {
        body = raw;
      }
    }

    // normalize provider failure
    throw new InternalError({ reason: 'SENDGRID_SEND_FAILED' }, { status: res.status, body });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new InternalError({ reason: 'SENDGRID_REQUEST_FAILED' }, err);
  } finally {
    clearTimeout(timeout);
  }
}

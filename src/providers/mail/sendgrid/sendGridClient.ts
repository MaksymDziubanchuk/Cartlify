import { AppError, InternalError } from '@utils/errors.js';

import { MAIL_PROVIDER_REFUSED, MAIL_PROVIDER_UNREACHABLE, type MailRefusal } from '../types.js';

// the request to SendGrid both streams make (sendGrid.provider.ts), its time limit and the way a
// refusal or a silence becomes our error: the key and the payload are the stream's

const SENDGRID_MAIL_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';

// how long SendGrid may take to answer before the mail is given up
export const SENDGRID_TIMEOUT_MS = 7000;

type AnyJson = Record<string, unknown> | unknown[] | string | number | boolean | null;

// whose fault a refusal of SendGrid is, by its status: the key or the account (401, 403), SendGrid
// busy (429, 5xx and any status it should not give), or the mail itself (any other 4xx)
export function refusalOf(status: number): MailRefusal {
  if (status === 401 || status === 403) return 'account';
  if (status >= 400 && status < 500 && status !== 429) return 'refused';
  return 'busy';
}

// posts one mail to SendGrid with the key of its stream. A mail it takes gets an id (the header
// X-Message-Id), which the events of the webhook name it by. A refusal is MAIL_PROVIDER_REFUSED
// (with whose fault it is, the status and the answer in the cause), no answer in time or at all is
// MAIL_PROVIDER_UNREACHABLE
export async function postToSendGrid(
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<{ messageId?: string }> {
  // bound external call time
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SENDGRID_TIMEOUT_MS);

  try {
    const res = await fetch(SENDGRID_MAIL_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (res.ok) {
      const messageId = res.headers.get('x-message-id');
      return messageId ? { messageId } : {};
    }

    // a body can be read only once, so it is read as text and then parsed: a "json" answer that is
    // not json still keeps its raw text
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

    throw new InternalError(
      { reason: MAIL_PROVIDER_REFUSED, failure: refusalOf(res.status) },
      { status: res.status, body },
    );
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new InternalError({ reason: MAIL_PROVIDER_UNREACHABLE }, err);
  } finally {
    clearTimeout(timeout);
  }
}

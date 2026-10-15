import env from '@config/env.js';
import { AppError, InternalError } from '@utils/errors.js';
import { escapeHtml } from '@helpers/escapeHtml.js';

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{
    content: string; // base64
    type: string; // e.g. "image/png"
    filename: string;
    disposition?: 'inline' | 'attachment';
    content_id?: string; // for cid images
  }>;
};

type AnyJson = Record<string, unknown> | unknown[] | string | number | boolean | null;

// reasons sendEmail gives when the provider refused or did not answer
const PROVIDER_FAILURE_REASONS = new Set(['SENDGRID_SEND_FAILED', 'SENDGRID_REQUEST_FAILED']);

// tells a failure of the mail provider (a bad gateway for the client) from our own error,
// like a missing setting, which stays a server error
export function isEmailProviderFailure(err: unknown): boolean {
  const reason =
    err instanceof AppError ? (err.details as { reason?: unknown } | undefined)?.reason : undefined;
  return typeof reason === 'string' && PROVIDER_FAILURE_REASONS.has(reason);
}

// transactional email main flow
// build provider payload
// map provider errors to app
export async function sendEmail(input: SendEmailInput): Promise<{ status: number }> {
  // require email config
  if (!env.SENDGRID_API_KEY) throw new InternalError({ reason: 'SENDGRID_API_KEY_REQUIRED' });
  if (!env.EMAIL_FROM) throw new InternalError({ reason: 'EMAIL_FROM_REQUIRED' });
  if (!env.EMAIL_REPLY_TO) throw new InternalError({ reason: 'EMAIL_REPLY_TO_REQUIRED' });

  const to = input.to?.trim();
  const subject = input.subject?.trim();
  const text = input.text?.trim();

  // validate email request: the address comes from the database, subject and text from a
  // template, so an empty one is a server bug, not a bad request
  if (!to) throw new InternalError({ reason: 'EMAIL_TO_REQUIRED' });
  if (!subject) throw new InternalError({ reason: 'EMAIL_SUBJECT_REQUIRED' });
  if (!text) throw new InternalError({ reason: 'EMAIL_TEXT_REQUIRED' });

  const html = input.html?.trim() || `<p>${escapeHtml(text)}</p>`;

  // bound external call time
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    // prepare provider payload
    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME || 'Cartlify' },
      reply_to: { email: env.EMAIL_REPLY_TO, name: env.EMAIL_FROM_NAME || 'Cartlify' },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
      tracking_settings: {
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: false },
      },
      attachments: input.attachments?.length ? input.attachments : undefined,
    };

    // send via provider api
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    // accept provider delivery
    if (res.ok) return { status: res.status };

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

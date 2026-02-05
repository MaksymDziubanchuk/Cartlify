import env from '@config/env.js';
import { BadRequestError } from '@utils/errors.js';
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

// transactional email main flow
// build provider payload
// map provider errors to app
export async function sendEmail(input: SendEmailInput): Promise<{ status: number }> {
  // require email config
  if (!env.SENDGRID_API_KEY) throw new BadRequestError('SENDGRID_API_KEY_REQUIRED');
  if (!env.EMAIL_FROM) throw new BadRequestError('EMAIL_FROM_REQUIRED');
  if (!env.EMAIL_REPLY_TO) throw new BadRequestError('EMAIL_REPLY_TO_REQUIRED');

  const to = input.to?.trim();
  const subject = input.subject?.trim();
  const text = input.text?.trim();

  // validate email request
  if (!to) throw new BadRequestError('EMAIL_TO_REQUIRED');
  if (!subject) throw new BadRequestError('EMAIL_SUBJECT_REQUIRED');
  if (!text) throw new BadRequestError('EMAIL_TEXT_REQUIRED');

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

    // capture provider error details
    const contentType = res.headers.get('content-type') || '';
    let body: AnyJson = '';

    try {
      body = contentType.includes('application/json') ? await res.json() : await res.text();
    } catch {
      body = await res.text().catch(() => '');
    }

    // normalize provider failure
    const err = new BadRequestError('SENDGRID_SEND_FAILED');
    (err as any).meta = { status: res.status, body };
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

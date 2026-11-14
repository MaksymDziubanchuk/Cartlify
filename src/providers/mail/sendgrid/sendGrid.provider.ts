import env from '@config/env.js';
import { InternalError } from '@utils/errors.js';

import { MAIL_PROVIDER_NOT_CONFIGURED, type MailProvider, type MailStream } from '../types.js';

import { postToSendGrid } from './sendGridClient.js';
import { readSendGridEvents } from './sendGridEvents.js';
import {
  SENDGRID_SIGNATURE_HEADER,
  SENDGRID_TIMESTAMP_HEADER,
  verifySendGridSignature,
} from './sendGridSignature.js';
import { clearSpamReport } from './sendGridSpamReports.js';

// the biggest body of the Event Webhook of SendGrid, in bytes. SendGrid delivers the events in batches
// (up to about 3 MB, as far as its documentation tells), where every other json body is cut at 1 MB.
// The body is read whole before the signature can be checked, so the limit is no bigger than a batch
const SENDGRID_WEBHOOK_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

// each stream is an account of SendGrid of its own: the orders (SENDGRID_API_KEY) and the
// newsletters (SENDGRID_NEWSLETTER_API_KEY), so the lists of complaints, bounces and unsubscribes of
// the newsletters stay on their account
const keyOf = (stream: MailStream): string =>
  (stream === 'orders' ? env.SENDGRID_API_KEY : env.SENDGRID_NEWSLETTER_API_KEY).trim();

const headerOf = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | null => {
  const value = headers[name];
  return typeof value === 'string' && value.trim() ? value : null;
};

export const sendGridProvider: MailProvider = {
  name: 'sendgrid',
  label: 'SendGrid',

  isConfigured: (stream) => keyOf(stream) !== '',

  async send(stream, mail) {
    const key = keyOf(stream);
    if (!key) throw new InternalError({ reason: MAIL_PROVIDER_NOT_CONFIGURED, stream });

    const headers = mail.headers ?? {};
    const tags = mail.tags ?? {};

    return postToSendGrid(key, {
      personalizations: [{ to: [{ email: mail.to }] }],
      from: mail.from,
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
      subject: mail.subject,
      content: [
        { type: 'text/plain', value: mail.text },
        { type: 'text/html', value: mail.html },
      ],
      ...(mail.category ? { categories: [mail.category] } : {}),
      // the links of the mails are the app's: SendGrid must not rewrite them, count the openings
      // or add a footer of its own
      tracking_settings: {
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: false },
        subscription_tracking: { enable: false },
        ganalytics: { enable: false },
      },
      ...(Object.keys(headers).length ? { headers } : {}),
      // SendGrid takes text only, and gives them back on every event of the mail
      ...(Object.keys(tags).length ? { custom_args: tags } : {}),
      ...(mail.attachments?.length
        ? {
            attachments: mail.attachments.map((file) => ({
              content: file.content,
              type: file.type,
              filename: file.filename,
              disposition: 'attachment',
            })),
          }
        : {}),
    });
  },

  clearComplaint: clearSpamReport,

  webhook: {
    bodyLimit: SENDGRID_WEBHOOK_BODY_LIMIT_BYTES,

    headers: {
      type: 'object',
      additionalProperties: true,
      required: [SENDGRID_SIGNATURE_HEADER, SENDGRID_TIMESTAMP_HEADER],
      properties: {
        [SENDGRID_SIGNATURE_HEADER]: {
          type: 'string',
          minLength: 1,
          description:
            'The signature SendGrid puts on the request: the base64 of the DER signature (ECDSA, P-256, SHA-256) of the timestamp followed by the raw body.',
        },
        [SENDGRID_TIMESTAMP_HEADER]: {
          type: 'string',
          minLength: 1,
          description:
            'The time of the request in seconds since the epoch, as text; it is part of what is signed.',
        },
      },
      examples: [
        {
          [SENDGRID_SIGNATURE_HEADER]: 'MEUCIQDw8mQ0y5d5i4...base64-of-the-der-signature...',
          [SENDGRID_TIMESTAMP_HEADER]: '1788953400',
        },
      ],
    },

    description:
      'SendGrid posts the events of the mails it sent with the key of the newsletters (Settings, Mail ' +
      'Settings, Event Webhook of that account; the events to tick are Dropped, Bounced and Spam ' +
      'Reports), from its own servers, as a JSON list. The request is signed (Signed Event Webhook, ' +
      'ECDSA over P-256 with SHA-256): `X-Twilio-Email-Event-Webhook-Signature` is the base64 of the ' +
      'DER signature of the text of `X-Twilio-Email-Event-Webhook-Timestamp` (seconds since the ' +
      'epoch) followed by the exact bytes of the body, checked with the Verification Key of the ' +
      'webhook (`SENDGRID_NEWSLETTER_WEBHOOK_KEY`); a request dated more than a day and an hour back, ' +
      'or minutes ahead, is refused as well. Its events in the words of the shop: `bounce` is a ' +
      'bounce, but one of the type `blocked` (the receiving server refused the mail for a reason ' +
      'that is not the address) is a drop; `dropped` is a drop, and its field `reason` says when the ' +
      'address is one SendGrid knows as bounced (`Bounced Address`) or as one that reported spam ' +
      '(`Spam Reporting Address`), read without regard to the case and the spaces around it; ' +
      '`spamreport` is a complaint. Every other event (delivered, open, click, deferred, processed, ' +
      'unsubscribe, group events) is left alone. The custom arguments of a mail come back on the ' +
      'same level as the fields of the event. SendGrid delivers each event at least once, and a ' +
      'batch again for a day after an error.',

    check({ headers, rawBody }) {
      const signature = headerOf(headers, SENDGRID_SIGNATURE_HEADER);
      const timestamp = headerOf(headers, SENDGRID_TIMESTAMP_HEADER);
      if (!signature || !timestamp) return { verdict: 'missing' };

      const verdict = verifySendGridSignature({
        publicKey: env.SENDGRID_NEWSLETTER_WEBHOOK_KEY,
        signature,
        timestamp,
        rawBody,
      });

      if (verdict === 'valid') return { verdict: 'valid' };
      if (verdict === 'key_missing' || verdict === 'key_invalid') {
        return { verdict: 'unavailable', reason: verdict };
      }
      return { verdict: 'invalid', reason: verdict };
    },

    readEvents: readSendGridEvents,
  },
};

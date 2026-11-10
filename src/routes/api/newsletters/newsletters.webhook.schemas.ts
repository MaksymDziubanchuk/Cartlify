import type { FastifySchema } from 'fastify';

import { SENDGRID_WEBHOOK_BODY_LIMIT_BYTES } from '@config/limits.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const BODY_LIMIT_MB = SENDGRID_WEBHOOK_BODY_LIMIT_BYTES / (1024 * 1024);

const webhookHeadersExample = {
  'x-twilio-email-event-webhook-signature': 'MEUCIQDw8mQ0y5d5i4...base64-of-the-der-signature...',
  'x-twilio-email-event-webhook-timestamp': '1788953400',
};

const webhookResponseExample = { received: true, applied: 2, skipped: 5 };

const postSendGridWebhookSchema = {
  operationId: 'handleSendGridNewsletterWebhook',
  summary: 'Handle the Event Webhook of SendGrid for the newsletters',
  description:
    'Not for a page of the frontend: SendGrid posts here, from its own servers, the events of the mails ' +
    'it sent with the key of the newsletters (Settings, Mail Settings, Event Webhook; the address is ' +
    '`/api/newsletters/sendgrid/webhook` of the environment, the events to tick are Dropped, Bounced and ' +
    'Spam Reports). The body is a JSON list of events. The request is signed (Signed Event Webhook, ' +
    'ECDSA over P-256 with SHA-256): `X-Twilio-Email-Event-Webhook-Signature` is the base64 of the DER ' +
    'signature of the text of `X-Twilio-Email-Event-Webhook-Timestamp` (seconds since the epoch) ' +
    'followed by the exact bytes of the body, checked with the Verification Key of the webhook ' +
    '(`SENDGRID_NEWSLETTER_WEBHOOK_KEY`). The signature is checked before the body is read; a request ' +
    'dated more than a day and an hour back, or minutes ahead, is refused as well. Three kinds of ' +
    'events are kept: `bounce` (the address does not exist: the mail is marked as bounced and the ' +
    'subscription ends with the reason `bounced`; a bounce SendGrid calls a block, `type: blocked`, is ' +
    'a refusal that is not about the address and is told as a drop), `dropped` (the mail is marked as ' +
    'dropped and counted as not delivered; the subscription stays, unless the field `reason` of the ' +
    'event says why SendGrid dropped it and the reason is that the address bounced before, ' +
    '`Bounced Address`: the subscription ends as for a bounce, or that it reported spam before, ' +
    '`Spam Reporting Address`: the subscription pauses as for a spam report, but the mail is not ' +
    'counted as a complaint; any other reason, or none, leaves the subscription; the reason is read ' +
    'without regard to the case and the spaces around it, and for a drop only) and `spamreport` (the mail is marked as a complaint and the ' +
    'subscription pauses with the reason `paused_complaint`; the person resumes it on the page behind ' +
    '"Manage the subscription"). The first outcome of a mail is final, so an event that comes again ' +
    '(SendGrid delivers each at least once, and delivers a batch again after an error) changes ' +
    'nothing. Every other event (delivered, open, click, deferred, processed, unsubscribe, group ' +
    'events) is acknowledged and left alone. The two webhooks of the account (dev and prod) hear ' +
    'every event of the account, the mails of the orders and of the other environment too: an ' +
    'event counts only when it carries the three custom arguments of a mail of the newsletters of ' +
    'this environment (`campaignId`, `recipientId` and `environment`, put on the mail when it is sent) ' +
    'and its recipient exists in this database; the rest is acknowledged and left alone, never an ' +
    'error. When the database fails on an event, the others are still stored and the answer is an ' +
    'error, so that SendGrid delivers the batch again. No csrf token and no cookie; the route is ' +
    'outside the request rate limit, the signature keeps anybody else out.',

  // inline, not a $ref: fastify lowercases header names only in an inline headers schema
  headers: {
    type: 'object',
    additionalProperties: true,
    required: ['x-twilio-email-event-webhook-signature', 'x-twilio-email-event-webhook-timestamp'],
    properties: {
      'x-twilio-email-event-webhook-signature': {
        type: 'string',
        minLength: 1,
        description:
          'The signature SendGrid puts on the request: the base64 of the DER signature (ECDSA, P-256, SHA-256) of the timestamp followed by the raw body.',
      },
      'x-twilio-email-event-webhook-timestamp': {
        type: 'string',
        minLength: 1,
        description:
          'The time of the request in seconds since the epoch, as text; it is part of what is signed.',
      },
    },
    examples: [webhookHeadersExample],
  },

  consumes: ['application/json'],

  response: {
    200: {
      description:
        'The events were handled: `applied` of them were stored for mails of this environment, the rest was left alone.',
      $ref: 'newslettersSendGridWebhookResponseSchema#',
      examples: [webhookResponseExample],
    },
    400: {
      description:
        '`SENDGRID_SIGNATURE_REQUIRED`: the signature or the timestamp header is blank. `REQUEST_BODY_INVALID_JSON`: the body is signed and is not JSON. `SENDGRID_EVENTS_INVALID`: the body is signed and is JSON, but not a list of events.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description:
        '`SENDGRID_SIGNATURE_INVALID`: the signature does not hold (not made with the key of the webhook over this timestamp and body), the timestamp is no number of seconds, or the request is older than a day and an hour or dated minutes ahead. Nothing was stored.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The database was too busy for an event, so the batch is answered with an error for SendGrid to deliver it again; the events that were stored stay (applying them again changes nothing).',
      $ref: 'errorResponseSchema#',
    },
    413: {
      description: `\`PAYLOAD_TOO_LARGE\`: the body is over ${BODY_LIMIT_MB} MB, more than any batch of events SendGrid delivers.`,
      $ref: 'errorResponseSchema#',
    },
    415: {
      description:
        '`UNSUPPORTED_MEDIA_TYPE`: the body is not `application/json`, which is how SendGrid posts it.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description:
        'Unexpected server error, also a failure of the database on an event: the events that were stored stay, the answer is an error for SendGrid to deliver the batch again.',
      $ref: 'errorResponseSchema#',
    },
    503: {
      description:
        '`SENDGRID_WEBHOOK_KEY_UNAVAILABLE`: the server has no usable Verification Key (`SENDGRID_NEWSLETTER_WEBHOOK_KEY` is empty or is not a P-256 public key), so it can take no request as signed and stores nothing; SendGrid delivers the batch again.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

export const newslettersWebhookSchema = withOpenApiTag(
  { postSendGridWebhookSchema },
  'newsletters',
);

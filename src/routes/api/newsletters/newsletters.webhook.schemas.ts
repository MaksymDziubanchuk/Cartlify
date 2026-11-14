import type { FastifySchema } from 'fastify';

import { withOpenApiTag } from '@helpers/withOpenApiTag.js';
import { MAIL_WEBHOOK_PATH, mailProvider } from '@providers/mail/index.js';

const { label, webhook } = mailProvider;

const BODY_LIMIT_MB = webhook.bodyLimit / (1024 * 1024);

const webhookResponseExample = { received: true, applied: 2, skipped: 5 };

const postMailWebhookSchema = {
  operationId: 'handleNewsletterMailWebhook',
  summary: `Handle the events of the mails of the newsletters (${label})`,
  description:
    `Not for a page of the frontend: the mail provider (${label}) posts here, from its own ` +
    `servers, the events of the mails it sent with the account of the newsletters; the address is ` +
    `\`${MAIL_WEBHOOK_PATH}\` of the environment. The request is signed, and the signature is ` +
    'checked before the body is read. Three kinds of events are kept: a bounce (the address does ' +
    'not exist: the mail is marked as bounced and the subscription ends with the reason ' +
    '`bounced`), a drop (the mail did not arrive: it is marked as dropped and counted as not ' +
    'delivered; the subscription stays, unless the provider says it dropped the mail because the ' +
    'address bounced before: the subscription ends as for a bounce, or because it complained ' +
    'before: the subscription pauses as for a complaint, but the mail is not counted as one) and a ' +
    'complaint (the reader marked the mail as spam: it is marked as a complaint and the ' +
    'subscription pauses with the reason `paused_complaint`; the person resumes it on the page ' +
    'behind "Manage the subscription"). The first outcome of a mail is final, so an event that ' +
    'comes again changes nothing; every other event is acknowledged and left alone. The webhooks of ' +
    'dev and prod hear every event of the account, the mails of the orders and of the other ' +
    'environment too: an event counts only when it carries the three tags of a mail of the ' +
    'newsletters of this environment (`campaignId`, `recipientId` and `environment`, put on the ' +
    'mail when it is sent) and its recipient exists in this database; the rest is acknowledged and ' +
    'left alone, never an error. When the database fails on an event, the others are still stored ' +
    'and the answer is an error, so that the provider delivers the batch again. No csrf token and ' +
    'no cookie; the route is outside the request rate limit, the signature keeps anybody else out. ' +
    `How ${label} posts and signs: ${webhook.description}`,

  // inline, not a $ref: fastify lowercases header names only in an inline headers schema
  headers: webhook.headers,

  consumes: ['application/json'],

  response: {
    200: {
      description:
        'The events were handled: `applied` of them were stored for mails of this environment, the rest was left alone.',
      $ref: 'newslettersMailWebhookResponseSchema#',
      examples: [webhookResponseExample],
    },
    400: {
      description:
        '`MAIL_WEBHOOK_SIGNATURE_REQUIRED`: a header of the signature is blank. `REQUEST_BODY_INVALID_JSON`: the body is signed and is not JSON. `MAIL_WEBHOOK_EVENTS_INVALID`: the body is signed and is JSON, but not a batch of events.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description:
        '`MAIL_WEBHOOK_SIGNATURE_INVALID`: the signature does not hold (not made with the key of the webhook over this request), or the request is too old or dated ahead. Nothing was stored.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The database was too busy for an event, so the batch is answered with an error for the provider to deliver it again; the events that were stored stay (applying them again changes nothing).',
      $ref: 'errorResponseSchema#',
    },
    413: {
      description: `\`PAYLOAD_TOO_LARGE\`: the body is over ${BODY_LIMIT_MB} MB, more than any batch of events the provider delivers.`,
      $ref: 'errorResponseSchema#',
    },
    415: {
      description:
        '`UNSUPPORTED_MEDIA_TYPE`: the body is not `application/json`, which is how the provider posts it.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description:
        'Unexpected server error, also a failure of the database on an event: the events that were stored stay, the answer is an error for the provider to deliver the batch again.',
      $ref: 'errorResponseSchema#',
    },
    503: {
      description:
        '`MAIL_WEBHOOK_KEY_UNAVAILABLE`: the server has no usable key to check the signature with (its setting is empty or is no key of the kind the provider signs with), so it can take no request as signed and stores nothing; the provider delivers the batch again.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

export const newslettersWebhookSchema = withOpenApiTag({ postMailWebhookSchema }, 'newsletters');

import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { signNewsletterWebhook } from './newsletterWebhookKey.js';

// The Event Webhook of SendGrid for the tests of the newsletters: the events as SendGrid sends them,
// signed the way SendGrid signs them (tests/helpers/newsletterWebhookKey.ts holds the key pair of the
// test file, its public half is the SENDGRID_NEWSLETTER_WEBHOOK_KEY the app reads)

export const WEBHOOK_URL = '/api/newsletters/sendgrid/webhook';
export const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

// the environment the tests run in, the mark every mail of the newsletters carries (a literal on
// purpose: the tests hold the app to it, they do not borrow it from the app)
export const TEST_ENVIRONMENT = 'test';

// the seconds since the epoch, the way SendGrid writes the time of a request
export const nowSeconds = (offsetSeconds = 0): number =>
  Math.floor(Date.now() / 1000) + offsetSeconds;

export type MailRef = { campaignId: number | string; recipientId: number | string };

// What the other events of an account hold as well: the address, the time, the ids SendGrid gives.
// The app reads none of them but the event and the custom arguments of the mail, which SendGrid
// puts on the same level as its own fields
const FIELDS_OF: Record<string, Record<string, unknown>> = {
  bounce: {
    type: 'bounce',
    status: '5.1.1',
    reason: '550 5.1.1 The email account that you tried to reach does not exist.',
    bounce_classification: 'Invalid Address',
  },
  // a drop SendGrid makes because the address is on its own list of unsubscribed addresses: it says
  // why in "reason" (other reasons: "Bounced Address", "Spam Reporting Address", "Invalid",
  // "Spam Content"). The app reads the reason; this one touches only the counter
  dropped: { reason: 'Unsubscribed Address', status: '5.0.0' },
  spamreport: {},
};

export function mailEvent(
  event: string,
  ref: MailRef | null,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    email: 'reader@example.com',
    timestamp: nowSeconds(),
    event,
    category: ['newsletter'],
    sg_event_id: randomUUID().replaceAll('-', ''),
    sg_message_id: `${randomUUID().replaceAll('-', '').slice(0, 20)}.filter0001.1.0`,
    'smtp-id': '<mail@example.com>',
    ...(FIELDS_OF[event] ?? {}),
    ...(ref
      ? {
          campaignId: String(ref.campaignId),
          recipientId: String(ref.recipientId),
          environment: TEST_ENVIRONMENT,
        }
      : {}),
    ...over,
  };
}

// a signer with a key pair of its own: the signature of a request from somebody else
export function signerOfAnotherKey(): (timestamp: string, body: string | Buffer) => string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  return (timestamp, body) => {
    const signer = createSign('SHA256');
    signer.update(timestamp);
    signer.update(body);
    return signer.sign(privateKey).toString('base64');
  };
}

export type Delivery = {
  // the bytes sent, when they are not the JSON of the events (a body that is not an array, one that
  // is changed after signing)
  body?: string | Buffer;
  // the bytes the signature is made over, when they are not the body sent
  signedBody?: string | Buffer;
  timestamp?: number | string;
  // the timestamp the signature is made over, when it is not the one in the header
  signedTimestamp?: number | string;
  // null leaves the header out
  signature?: string | null;
  signWith?: (timestamp: string, body: string | Buffer) => string;
  omitTimestamp?: boolean;
  contentType?: string;
  headers?: Record<string, string>;
};

// the request of the Event Webhook: the headers and the body of a delivery of the events
export function requestOf(events: unknown, delivery: Delivery = {}) {
  const body = delivery.body ?? JSON.stringify(events);
  const timestamp = String(delivery.timestamp ?? nowSeconds());
  const sign = delivery.signWith ?? signNewsletterWebhook;
  const signature =
    delivery.signature === undefined
      ? sign(String(delivery.signedTimestamp ?? timestamp), delivery.signedBody ?? body)
      : delivery.signature;

  return {
    headers: {
      'content-type': delivery.contentType ?? 'application/json',
      ...(signature === null ? {} : { [SIGNATURE_HEADER]: signature }),
      ...(delivery.omitTimestamp ? {} : { [TIMESTAMP_HEADER]: timestamp }),
      ...delivery.headers,
    },
    payload: body,
  };
}

// the events delivered to the app the way SendGrid does it
export const deliverEvents = (
  app: FastifyInstance,
  events: unknown,
  delivery: Delivery = {},
): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url: WEBHOOK_URL, ...requestOf(events, delivery) });

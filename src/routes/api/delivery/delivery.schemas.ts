import type { FastifySchema } from 'fastify';

import { withOpenApiTag } from '@helpers/withOpenApiTag.js';
import { deliveryProvider } from '@providers/delivery/index.js';

const getDeliveryMethodsSchema = {
  operationId: 'getDeliveryMethods',
  summary: 'Get how the shop delivers',
  description:
    'The methods the shop has enabled, each with what it costs, from which sum of the items it is ' +
    'free, the countries it goes to, and for a pickup where and when a buyer collects an order. ' +
    'The page that confirms an order shows them. Everybody reads it, a guest too.',

  response: {
    200: {
      description: 'The methods of the shop.',
      $ref: 'deliveryMethodsResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the methods.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// the events of the parcels the delivery provider posts
const postDeliveryWebhookSchema = {
  operationId: 'postDeliveryWebhook',
  summary: 'Take an event of the parcels from the delivery provider',
  description:
    deliveryProvider.webhook.description +
    ' What the shop does: the parcel moves on (the carrier took it, delivered it, it goes back, it ' +
    'is back, lost), never back and never after its void; the order becomes shipped once the ' +
    'carrier took every live parcel and they hold every unit, delivered once every one is ' +
    'delivered (the buyer is mailed); an order something holds is not moved. A parcel the shop ' +
    'does not know, a repeat, an event of a voided parcel, change nothing and are answered 200. ' +
    'Called by the provider, not by a browser.',
  headers: deliveryProvider.webhook.headers,
  body: {
    type: 'object',
    additionalProperties: true,
    description: 'One event of the provider, as it posts it.',
  },
  response: {
    200: {
      description: 'The event was taken (or left alone).',
      type: 'object',
      additionalProperties: true,
    },
    400: {
      description: '`VALIDATION_ERROR`: no body.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: '`DELIVERY_WEBHOOK_SECRET_MISSING`: the request carries no secret.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: '`DELIVERY_WEBHOOK_SECRET_INVALID`: the secret is another one.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while taking the event; the provider tries again.',
      $ref: 'errorResponseSchema#',
    },
    503: {
      description:
        '`DELIVERY_WEBHOOK_UNAVAILABLE`: the server has no secret to check it with; the provider ' +
        'tries again later.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

export const deliverySchemas = withOpenApiTag(
  { getDeliveryMethodsSchema, postDeliveryWebhookSchema },
  'delivery',
);

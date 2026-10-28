import type { FastifySchema } from 'fastify';

import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

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

export const deliverySchemas = withOpenApiTag({ getDeliveryMethodsSchema }, 'delivery');

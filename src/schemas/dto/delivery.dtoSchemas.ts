// DELIVERY: how the shop gets an order to its buyer

import { DELIVERY_METHOD_NAMES } from '@config/deliveryMethods.js';

const deliveryMethodInfoSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    method: {
      type: 'string',
      enum: [...DELIVERY_METHOD_NAMES],
      description:
        'manual: the shop sends the order itself, to an address, at the price of the zone of the ' +
        'country; pickup: the buyer collects it at the shop; carrier: a carrier of the delivery ' +
        'provider the buyer picks for the address, at its price (POST ' +
        '/api/orders/current/delivery-options).',
    },
    address: {
      type: ['string', 'null'],
      description: 'Where a buyer collects an order, the pickup only.',
    },
    hours: {
      type: ['string', 'null'],
      description:
        'When a buyer collects an order, the pickup only, as root wrote it in its format ' +
        '("Mon-Fri 09:00-18:00; Sat 10:00-14:00", pickupHours of the data of the shop, ' +
        'docs/shop-settings.md): the frontend parses it and shows it in its language.',
    },
  },
  required: ['method', 'address', 'hours'],
} as const;

const deliveryZoneInfoSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'The name of the zone.' },
    countries: {
      type: 'array',
      items: { type: 'string', minLength: 2, maxLength: 2 },
      description:
        'The countries of the zone (ISO codes); for the zone of the rest every country the app ' +
        'delivers to that no other zone names.',
    },
    manualPrice: {
      type: ['number', 'null'],
      description:
        'What the manual delivery to the zone costs; null: the manual delivery does not go there.',
    },
    freeFrom: {
      type: ['number', 'null'],
      description:
        'From this sum of the items on every delivery to the zone is free, the sum itself included ' +
        '(the carriers too); empty when the zone names none.',
    },
  },
  required: ['name', 'countries', 'manualPrice', 'freeFrom'],
} as const;

const deliveryMethodsResponseSchema = {
  $id: 'deliveryMethodsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    currency: {
      type: 'string',
      description: 'The currency of the prices, the one of the catalog.',
    },
    methods: { type: 'array', items: deliveryMethodInfoSchema },
    zones: {
      type: 'array',
      items: deliveryZoneInfoSchema,
      description:
        'The countries the shop delivers to, whatever the method, in zones; a delivery to an ' +
        'address in a country of none of them is refused.',
    },
  },
  required: ['currency', 'methods', 'zones'],
} as const;

export const deliveryDtoSchemas = [deliveryMethodsResponseSchema];

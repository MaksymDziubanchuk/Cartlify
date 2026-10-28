// DELIVERY: how the shop gets an order to its buyer

const deliveryMethodInfoSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    method: {
      type: 'string',
      enum: ['manual', 'pickup'],
      description:
        'manual: the shop sends the order itself, to an address; pickup: the buyer collects it ' +
        'at the shop.',
    },
    price: {
      type: 'number',
      description:
        'What a buyer pays for the delivery, 0 for a pickup and when the shop names no price.',
    },
    freeFrom: {
      type: ['number', 'null'],
      description:
        'From this sum of the items on the delivery is free, the sum itself included; empty when ' +
        'the shop names none.',
    },
    countries: {
      type: 'array',
      items: { type: 'string', minLength: 2, maxLength: 2 },
      description: 'The countries the delivery goes to (ISO codes), none for a pickup.',
    },
    address: {
      type: ['string', 'null'],
      description: 'Where a buyer collects an order, the pickup only.',
    },
    hours: {
      type: ['string', 'null'],
      description: 'When a buyer collects an order, the pickup only.',
    },
  },
  required: ['method', 'price', 'freeFrom', 'countries', 'address', 'hours'],
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
  },
  required: ['currency', 'methods'],
} as const;

export const deliveryDtoSchemas = [deliveryMethodsResponseSchema];

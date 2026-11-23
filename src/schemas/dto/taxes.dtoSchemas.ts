// TAXES: the countries the shop sells to with the rule of their tax, and the tax groups of the
// products (docs/taxes.md)

import {
  THRESHOLD_PERIODS,
  DELIVERY_VAT_RULES,
  EXPORT_PRICE_RULES,
  TAX_NUMBER_KINDS,
  TAX_RULES,
} from '@config/shopCountries.js';

const dateTimeSchema = { type: 'string', format: 'date-time' } as const;
const nullableDateTimeSchema = { type: ['string', 'null'], format: 'date-time' } as const;

const countrySchema = {
  type: 'string',
  pattern: '^[A-Z]{2}$',
  description: 'A country: two capital letters (ISO 3166-1 alpha-2).',
} as const;

// above zero to the cent, at most what an amount of the shop holds
const amountSchema = {
  type: 'number',
  exclusiveMinimum: 0,
  maximum: 99999999.99,
  multipleOf: 0.01,
} as const;

// a text root writes: trimmed, not empty
const textOf = (maxLength: number, description: string) =>
  ({
    type: ['string', 'null'],
    minLength: 1,
    maxLength,
    pattern: '^\\S(.*\\S)?$',
    description,
  }) as const;

const zoneSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['name', 'manualPrice', 'freeFrom'],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      pattern: '^\\S(.*\\S)?$',
      description: 'The zone of the delivery the country goes into; a new name makes a zone.',
    },
    manualPrice: {
      type: ['number', 'null'],
      minimum: 0,
      maximum: 99999999.99,
      multipleOf: 0.01,
      description:
        'What the manual delivery to the zone costs; null: the manual delivery does not go there. ' +
        'It is the price of the whole zone, its other countries too.',
    },
    freeFrom: {
      ...amountSchema,
      type: ['number', 'null'],
      description: 'From this sum of the items every delivery to the zone is free; null: never.',
    },
  },
  description:
    'The zone of the delivery of the country, with its prices (deliveryZones of the data of the ' +
    'shop). Null: the shop does not deliver there; the record only holds the rates (the country ' +
    'of the seller) or taxes a pickup there.',
} as const;

const parcelLimitSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['amount', 'withDelivery', 'withVat'],
  properties: {
    amount: { ...amountSchema, description: 'In the currency of the shop.' },
    withDelivery: {
      type: 'boolean',
      description: 'The delivery counts in the price of the parcel.',
    },
    withVat: { type: 'boolean', description: 'The price of the parcel with the tax, or without.' },
  },
  description:
    'The rule recipient holds up to this price of a parcel (Britain: 135 pounds without the ' +
    'delivery and the tax); above it a country with customs leaves the tax to the buyer on ' +
    'receipt. Null: no limit.',
} as const;

const thresholdProperties = {
  amount: {
    ...amountSchema,
    description: 'The sales of the period the rule recipient holds from.',
  },
  withVat: { type: 'boolean', description: 'The sales counted with the tax, or without.' },
  group: {
    ...textOf(50, 'Countries of one group share the threshold (the EU: 10 000 euro for all).'),
  },
  period: {
    type: 'string',
    enum: [...THRESHOLD_PERIODS],
    description:
      'The period the sales count in, for the whole group: year, a year from the 1st of startMonth ' +
      '(the EU: from January); rolling_12, the last 12 months.',
  },
  startMonth: {
    type: ['integer', 'null'],
    minimum: 1,
    maximum: 12,
    description: 'The month a year starts (1 to 12; null: January); null for rolling_12.',
  },
  nextCycle: {
    type: 'string',
    enum: ['recipient', 'initial'],
    description:
      'A year: the rule the next one starts with once this one passed the threshold, recipient ' +
      '(the tax of the recipient all of it, the law of the EU: this year or the year before) or ' +
      'initial (the first rule until the threshold is passed again). rolling_12: initial goes back ' +
      'to the first rule now, the tax of the recipient held since the sum passed the threshold ends.',
  },
} as const;

const thresholdSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['amount', 'withVat', 'group', 'period', 'startMonth', 'nextCycle'],
  properties: thresholdProperties,
  description:
    'The rule recipient holds once the sales of the period to the country (or its group), this ' +
    'order with them, pass the sum; the sum and the period are the same in every country of the ' +
    'group, a write of one writes the others. Null: no threshold.',
} as const;

const rateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['group', 'rate', 'from'],
  properties: {
    group: {
      type: ['integer', 'null'],
      minimum: 1,
      description: 'The tax group (GET /api/root/tax-groups); null: the main rate.',
    },
    rate: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      multipleOf: 0.01,
      description: 'In percent, to the hundredth.',
    },
    from: {
      ...nullableDateTimeSchema,
      description:
        'In force from this time (a rate the country announced for later); null: from the start. ' +
        'An old rate stays as history.',
    },
  },
} as const;

const ratesSchema = {
  type: 'array',
  maxItems: 1000,
  items: rateSchema,
  description:
    'The rates of the country: the main one and one of every tax group, each from the start, and ' +
    'the planned ones with their start. Needed with the rule recipient, and in the record of the ' +
    'country of a seller that takes the tax; empty elsewhere.',
} as const;

// the fields of a record a write gives and a read gives back
const recordProperties = {
  customsFree: {
    type: 'boolean',
    description: 'A parcel there crosses no customs border (the own country, the EU from the EU).',
  },
  rule: {
    type: ['string', 'null'],
    enum: [...TAX_RULES, null],
    description:
      'seller: the tax of the country of the seller; recipient: the tax of this country, while ' +
      'every condition written holds (the threshold, the limit of a parcel); none: no tax; ' +
      'buyer_at_receipt: customs take it from the buyer (a country with customs only). A country ' +
      'with customs takes recipient or buyer_at_receipt; a country without customs any rule but ' +
      'buyer_at_receipt, or null for a shop that takes no tax in its own country.',
  },
  registered: {
    type: 'boolean',
    description:
      'The shop is registered for the tax here (the rule recipient): its number is needed. Not ' +
      'registered, a sale the tax of this country would hold is refused.',
  },
  taxNumber: textOf(
    50,
    'The tax number of the shop here, for the documents and the customs papers.',
  ),
  taxNumberLabel: textOf(30, 'The words the documents print before the number (IOSS, UK VAT).'),
  taxNumberKind: {
    type: ['string', 'null'],
    enum: [...TAX_NUMBER_KINDS, null],
    description:
      'ioss: the number goes with the parcel (the import scheme of the EU); other: on a commercial ' +
      'invoice of the parcel.',
  },
  parcelLimit: parcelLimitSchema,
  deliveryVat: {
    type: ['string', 'null'],
    enum: [...DELIVERY_VAT_RULES, null],
    description:
      'How the tax comes out of the price of the delivery: main, at the main rate; proportional, ' +
      'in proportion to the items of each rate. Needed with a rule that takes a tax and with a ' +
      'price without the tax of the seller.',
  },
  exportPrice: {
    type: ['string', 'null'],
    enum: [...EXPORT_PRICE_RULES, null],
    description:
      'The price where no tax of the seller is taken (none, buyer_at_receipt, recipient across ' +
      'customs): same, or without_seller_vat (the tax of the seller comes out of it). Needed ' +
      'with those rules.',
  },
  exemptionText: textOf(
    500,
    'Why a document of a sale without tax has none, a reference to the law, in the language of ' +
      'the shop; needed where exportPrice is.',
  ),
  rates: ratesSchema,
} as const;

const shopCountryResponseSchema = {
  $id: 'shopCountryResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: [
    'country',
    'zone',
    ...Object.keys(recordProperties),
    'threshold',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    country: countrySchema,
    zone: zoneSchema,
    ...recordProperties,
    threshold: {
      ...thresholdSchema,
      required: [...thresholdSchema.required, 'cycleFrom', 'nextCycleFrom', 'held'],
      properties: {
        ...thresholdProperties,
        cycleFrom: { ...dateTimeSchema, description: 'The start of the cycle in force.' },
        nextCycleFrom: {
          ...nullableDateTimeSchema,
          description: 'The start of the next cycle of a year; null for rolling_12.',
        },
        held: {
          type: 'boolean',
          description:
            'The tax of the recipient holds whatever the sales of the cycle now: the cycle before ' +
            'passed the threshold (a year), or the sales passed it since root went back to the ' +
            'first rule (rolling_12).',
        },
      },
    },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
} as const;

const getShopCountriesResponseSchema = {
  $id: 'getShopCountriesResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: { items: { type: 'array', items: { $ref: 'shopCountryResponseSchema#' } } },
} as const;

const putShopCountryBodySchema = {
  $id: 'putShopCountryBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['zone', ...Object.keys(recordProperties), 'threshold'],
  properties: { zone: zoneSchema, ...recordProperties, threshold: thresholdSchema },
} as const;

const postCopyExceptionsBodySchema = {
  $id: 'postCopyExceptionsBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['from'],
  properties: {
    from: {
      ...countrySchema,
      description: 'The country whose classes of the products are copied.',
    },
  },
} as const;

const postCopyExceptionsResponseSchema = {
  $id: 'postCopyExceptionsResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: ['products'],
  properties: {
    products: { type: 'integer', minimum: 0, description: 'The products whose class was copied.' },
  },
} as const;

const taxGroupResponseSchema = {
  $id: 'taxGroupResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'products', 'exceptions', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    products: { type: 'integer', minimum: 0, description: 'The products in the group.' },
    exceptions: {
      type: 'integer',
      minimum: 0,
      description: 'The products a country classes in the group.',
    },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
} as const;

const getTaxGroupsResponseSchema = {
  $id: 'getTaxGroupsResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: { items: { type: 'array', items: { $ref: 'taxGroupResponseSchema#' } } },
} as const;

const groupNameSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  pattern: '^\\S(.*\\S)?$',
  description: 'The kind of the products (books, medicines), once in the list.',
} as const;

const postTaxGroupBodySchema = {
  $id: 'postTaxGroupBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'rates'],
  properties: {
    name: groupNameSchema,
    rates: {
      type: 'object',
      propertyNames: { pattern: '^[A-Z]{2}$' },
      additionalProperties: { type: 'number', minimum: 0, maximum: 100, multipleOf: 0.01 },
      description:
        'The rate of the group in each country that has rates, { country: percent }: every such ' +
        'country is needed, the rate is in force from the start.',
    },
  },
} as const;

const patchTaxGroupBodySchema = {
  $id: 'patchTaxGroupBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: groupNameSchema },
} as const;

export const taxesDtoSchemas = [
  shopCountryResponseSchema,
  getShopCountriesResponseSchema,
  putShopCountryBodySchema,
  postCopyExceptionsBodySchema,
  postCopyExceptionsResponseSchema,
  taxGroupResponseSchema,
  getTaxGroupsResponseSchema,
  postTaxGroupBodySchema,
  patchTaxGroupBodySchema,
];

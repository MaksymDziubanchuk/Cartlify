// SHOP SETTINGS: the data of the shop (delivery, brand, reservation, moderation, withdrawal,
// languages, the seller, the logo), a row a setting root writes (docs/shop-settings.md)

import { DELIVERY_METHOD_NAMES } from '@config/deliveryMethods.js';

const dateTimeSchema = { type: 'string', format: 'date-time' } as const;

// above zero to the cent, at most what the column holds (Decimal(10, 2)); the rules the env
// variable of the price was held to before root set it here
const moneySchema = {
  type: ['number', 'null'],
  exclusiveMinimum: 0,
  maximum: 99999999.99,
  multipleOf: 0.01,
} as const;
const textSchema = { type: ['string', 'null'] } as const;
const localeSchema = {
  type: 'string',
  pattern: '^[a-z]{2}$',
  description: 'A language of a dictionary the server has (src/locales): two lower-case letters.',
} as const;

// the fields every version carries, written and read the same way
const valueProperties = {
  deliveryMethods: {
    type: 'array',
    items: { type: 'string', enum: [...DELIVERY_METHOD_NAMES] },
    uniqueItems: true,
    description:
      'manual: the shop sends the order itself; pickup: the buyer collects it at the shop. ' +
      'Empty: the shop sends by hand, outside the app.',
  },
  deliveryFlatPrice: {
    ...moneySchema,
    description: 'What a buyer pays for the manual method, above zero; null for no fixed price.',
  },
  deliveryFreeFrom: {
    ...moneySchema,
    description: 'From this sum of the items the manual delivery is free; needs deliveryFlatPrice.',
  },
  deliveryCountries: {
    type: 'array',
    items: { type: 'string', minLength: 2, maxLength: 2, pattern: '^[A-Z]{2}$' },
    uniqueItems: true,
    description:
      'The countries the app delivers to (ISO codes): required once deliveryMethods has ' +
      '"manual" (GET /api/delivery/methods and POST /api/orders/confirm need it).',
  },
  pickupAddress: {
    type: 'string',
    maxLength: 300,
    description:
      'Where a buyer collects a pickup order; required (not blank) once deliveryMethods has ' +
      '"pickup", may be empty otherwise.',
  },
  pickupHours: {
    type: 'string',
    maxLength: 300,
    description:
      'When a buyer collects a pickup order, in one format (PUT refuses another, ' +
      'PICKUP_HOURS_INVALID): parts by "; ", in each the days and the hours by one space, for ' +
      'example "Mon-Fri 09:00-18:00; Sat 10:00-14:00" or "Mon,Wed 09:00-13:00,14:00-18:00". A ' +
      'day is Mon, Tue, Wed, Thu, Fri, Sat or Sun, a range of days Mon-Fri (the earlier day ' +
      'first), several of them by ","; the hours HH:MM-HH:MM on 24 hours (the end after the ' +
      'start, 24:00 at most), several of them by "," one after another; every day in one part ' +
      'only. The frontend parses it and shows it in its language, a mail shows the days in the ' +
      'language of its reader. Required (not blank) once deliveryMethods has "pickup", may be ' +
      'empty otherwise.',
  },
  shopName: {
    type: 'string',
    maxLength: 100,
    description: 'The brand on the pages and the mails.',
  },
  emailFromName: { type: 'string', maxLength: 100, description: 'The sender name of a mail.' },
  emailReplyTo: {
    type: 'string',
    maxLength: 254,
    description:
      'The address replies to a mail go to, also named in the mails as the one to write to; ' +
      'empty until root sets it, and no mail goes out while it is (GET ' +
      '/api/admin/shop-settings/missing names it).',
  },
  reservationMinutes: {
    type: 'integer',
    minimum: 1,
    description: 'How long the app holds the stock of a cart before it is confirmed.',
  },
  stripePageMinutes: {
    type: 'integer',
    minimum: 30,
    description:
      'How long the Stripe page of an order stays open after the reservation ends; together ' +
      'with reservationMinutes at most 1440 (a day, the most Stripe keeps a page).',
  },
  reviewCheckEnabled: { type: 'boolean', description: 'Whether the AI check of a review is on.' },
  avatarRemovalsLimit: {
    type: 'integer',
    minimum: 1,
    description: 'Removals of an avatar by a moderator the rules allow.',
  },
  reviewRemovalsLimit: {
    type: 'integer',
    minimum: 1,
    description: 'Removals of the reviews of an author by a moderator the rules allow.',
  },
  withdrawalGraceDays: {
    type: 'integer',
    minimum: 0,
    maximum: 30,
    description: 'Days of grace the shop adds to the legal minimum of a withdrawal.',
  },
  shopLocale: {
    ...localeSchema,
    description: 'The mail of a buyer with no dictionary of their own gets this.',
  },
  enabledLocales: {
    type: 'array',
    items: localeSchema,
    uniqueItems: true,
    description: 'The languages the shop answers in; shopLocale is one of them.',
  },
  sellerLegalName: {
    ...textSchema,
    maxLength: 200,
    description: 'The seller the shop names on its pages and at the foot of every mail.',
  },
  sellerAddress: { ...textSchema, maxLength: 500 },
  sellerTaxId: { ...textSchema, maxLength: 50 },
  sellerEmail: { ...textSchema, maxLength: 254 },
  sellerPhone: { ...textSchema, maxLength: 30 },
} as const;

const valueRequired = Object.keys(valueProperties);

const shopSettingsValuesResponseSchema = {
  $id: 'shopSettingsValuesResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: { ...valueProperties, logoUrl: textSchema },
  required: [...valueRequired, 'logoUrl'],
} as const;

const publicShopSettingsResponseSchema = {
  $id: 'publicShopSettingsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    shopName: valueProperties.shopName,
    logoUrl: textSchema,
    shopLocale: valueProperties.shopLocale,
    enabledLocales: valueProperties.enabledLocales,
    sellerLegalName: valueProperties.sellerLegalName,
    sellerAddress: valueProperties.sellerAddress,
    sellerTaxId: valueProperties.sellerTaxId,
    sellerEmail: valueProperties.sellerEmail,
    sellerPhone: valueProperties.sellerPhone,
  },
  required: [
    'shopName',
    'logoUrl',
    'shopLocale',
    'enabledLocales',
    'sellerLegalName',
    'sellerAddress',
    'sellerTaxId',
    'sellerEmail',
    'sellerPhone',
  ],
} as const;

// a setting root writes is held to more than one read back: a setting nobody set yet reads the
// reply-to as its empty default, a write names a real address (and the seller's email, when it
// names one, is one too)
const writeProperties = {
  ...valueProperties,
  emailReplyTo: { ...valueProperties.emailReplyTo, format: 'email' },
  sellerEmail: { ...valueProperties.sellerEmail, format: 'email' },
} as const;

const putShopSettingsBodySchema = {
  $id: 'putShopSettingsBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: writeProperties,
  required: valueRequired,
} as const;

// the settings root writes one by one (PUT /api/root/shop-settings/:key): every one but the logo
const WRITABLE_KEYS = valueRequired as (keyof typeof writeProperties)[];

const shopSettingKeyParamsSchema = {
  $id: 'shopSettingKeyParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    key: {
      type: 'string',
      enum: WRITABLE_KEYS,
      description: 'The setting to set: one of the fields of PUT /api/root/shop-settings.',
    },
  },
  required: ['key'],
} as const;

const putShopSettingBodySchema = {
  $id: 'putShopSettingBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    value: {
      description:
        'The value of the setting, of the shape and within the bounds the same field takes in ' +
        'PUT /api/root/shop-settings (a text, a number, a list of texts, true or false, or null ' +
        'where the field may be null).',
    },
  },
  required: ['value'],
} as const;

// the body of PUT /api/root/shop-settings/:key for each key: the value of the shape of its own
// field, checked by the controller (the schema of a body cannot depend on the path)
export const putShopSettingBodySchemas = Object.fromEntries(
  WRITABLE_KEYS.map((key) => [
    key,
    {
      type: 'object',
      additionalProperties: false,
      properties: { value: writeProperties[key] },
      required: ['value'],
    },
  ]),
) as Record<(typeof WRITABLE_KEYS)[number], object>;

// the settings of the history: the ones root sets and the logo (its id on Cloudinary is internal)
const HISTORY_KEYS = [...valueRequired, 'logoUrl'];

const shopSettingsHistoryQuerySchema = {
  $id: 'shopSettingsHistoryQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Rows on a page, 20 unless given.',
    },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'nextCursor of the page before.',
    },
    key: {
      type: 'string',
      enum: HISTORY_KEYS,
      description: 'Only the rows of this setting; every setting unless given.',
    },
  },
} as const;

const shopSettingsHistoryResponseSchema = {
  $id: 'shopSettingsHistoryResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description: 'Rows of the settings, the latest first: the value one setting took.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', enum: HISTORY_KEYS },
          value: {
            description:
              'The value the setting took, of the shape of its field (null for a setting set ' +
              'to none, the logo taken away for one).',
          },
          setBy: {
            description: 'null for a row the server wrote to fill in a default.',
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'integer' },
                  name: { type: ['string', 'null'] },
                  email: {
                    type: ['string', 'null'],
                    description: 'null for an account that was deleted.',
                  },
                },
                required: ['id', 'name', 'email'],
              },
            ],
          },
          createdAt: dateTimeSchema,
        },
        required: ['key', 'value', 'setBy', 'createdAt'],
      },
    },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'nextCursor'],
} as const;

// the form of the logo of the shop
const shopLogoFormSchema = {
  $id: 'shopLogoFormSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    image: {
      type: 'string',
      format: 'binary',
      description: 'The logo of the shop: a jpeg, png or webp file by its content.',
    },
  },
  required: ['image'],
} as const;

export const shopSettingsDtoSchemas = [
  shopSettingsValuesResponseSchema,
  publicShopSettingsResponseSchema,
  putShopSettingsBodySchema,
  shopSettingKeyParamsSchema,
  putShopSettingBodySchema,
  shopSettingsHistoryQuerySchema,
  shopSettingsHistoryResponseSchema,
  shopLogoFormSchema,
];

// SHOP SETTINGS: the data of the shop (delivery, brand, reservation, moderation, withdrawal,
// languages, the seller, the logo), a row a setting root writes (docs/shop-settings.md)

import { DELIVERY_METHOD_NAMES } from '@config/deliveryMethods.js';
import { paymentPageBounds } from '@providers/payments/index.js';

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
const countrySchema = {
  type: 'string',
  minLength: 2,
  maxLength: 2,
  pattern: '^[A-Z]{2}$',
} as const;
// a text of an address: not blank, no space at an end
const lineSchema = (maxLength: number) =>
  ({ type: 'string', minLength: 1, maxLength, pattern: '^\\S(.*\\S)?$' }) as const;

const deliveryZoneSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'countries', 'manualPrice', 'freeFrom'],
  properties: {
    name: { ...lineSchema(100), description: 'The name of the zone for root, once in the list.' },
    countries: {
      anyOf: [
        { type: 'array', minItems: 1, uniqueItems: true, items: countrySchema },
        { type: 'string', enum: ['rest'] },
      ],
      description:
        'The countries of the zone (ISO codes, each in one zone only), or "rest": every country ' +
        'the app delivers to that no other zone names (one such zone at most).',
    },
    manualPrice: {
      type: ['number', 'null'],
      minimum: 0,
      maximum: 99999999.99,
      multipleOf: 0.01,
      description:
        'What the manual delivery to the zone costs, 0 or more; null: the manual delivery does ' +
        'not go there (the carriers of the delivery provider still may).',
    },
    freeFrom: {
      ...moneySchema,
      description:
        'From this sum of the items every delivery to the zone is free, the carriers too (the shop ' +
        'pays the carrier); null: never.',
    },
  },
} as const;

const deliverySenderSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'name',
    'street',
    'house',
    'apartment',
    'city',
    'postalCode',
    'country',
    'phone',
    'email',
  ],
  properties: {
    name: lineSchema(200),
    street: lineSchema(150),
    house: lineSchema(20),
    apartment: { ...lineSchema(40), type: ['string', 'null'] },
    city: lineSchema(100),
    postalCode: { ...lineSchema(16), type: ['string', 'null'] },
    country: countrySchema,
    phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
    email: { type: 'string', maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+$' },
  },
  description:
    'Where the parcels of the delivery provider go from and how the carrier reaches the shop; ' +
    'required once deliveryMethods has "carrier".',
} as const;
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
      'manual: the shop sends the order itself, at the price of the zone of the country; pickup: ' +
      'the buyer collects it at the shop; carrier: a carrier of the delivery provider the buyer ' +
      'picks from its prices, the parcel made by the app (needs the key of the provider and ' +
      'deliverySender). Empty: the shop sends by hand, outside the app.',
  },
  deliveryZones: {
    type: 'array',
    maxItems: 100,
    items: deliveryZoneSchema,
    description:
      'The countries the shop delivers to, in zones (e.g. Spain 5, the EU 12, the rest 30), ' +
      'whatever the method: there is no other list of countries. Empty: the shop delivers nowhere.',
  },
  customsFreeCountries: {
    type: ['array', 'null'],
    items: countrySchema,
    uniqueItems: true,
    description:
      'The countries a parcel goes to without customs: the country of the shop and its customs ' +
      'union. A cart to any other country of a zone needs the customs code and the country of ' +
      'origin of every product. Null: not set, nothing is checked for customs.',
  },
  deliverySender: deliverySenderSchema,
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
  paymentPageMinutes: {
    type: 'integer',
    minimum: paymentPageBounds().least,
    description:
      'How long the payment page of an order stays open after the reservation ends: at least ' +
      `${paymentPageBounds().least} minutes, and together with reservationMinutes at most ` +
      `${paymentPageBounds().mostWithReservation} (the bounds every payment provider keeps a page in).`,
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
  newsletterLimitCount: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    description:
      'How many newsletter campaigns may go out in any window of newsletterLimitDays days ' +
      '(2 unless set): a campaign that would make one more is refused (NEWSLETTER_LIMIT_REACHED). ' +
      'Lowering it touches no campaign already scheduled; the limit is checked again when one starts.',
  },
  newsletterLimitDays: {
    type: 'integer',
    minimum: 1,
    maximum: 365,
    description:
      'The length in days of the window newsletterLimitCount counts in (7 unless set). Two ' +
      'campaigns exactly this many days apart are not in one window.',
  },
  newsletterFromName: {
    type: 'string',
    maxLength: 100,
    pattern: '^[^\\u0000-\\u001f\\u007f]*$',
    description:
      'The name the newsletters are sent under, one line of up to 100 characters; empty (the ' +
      'default) falls back to emailFromName, then to shopName.',
  },
  newsletterTrustedDomains: {
    type: 'array',
    maxItems: 50,
    items: {
      type: 'string',
      maxLength: 253,
      pattern: '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$',
    },
    uniqueItems: true,
    description:
      'Host names (lower case, at least two labels, no scheme, path or port) a text of a newsletter ' +
      'may link to besides the shop itself; up to 50, none twice. Empty by default.',
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

// the settings of the history: the ones root sets and the logo (its id in the file storage is internal)
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

const shopLocaleCountsResponseSchema = {
  $id: 'shopLocaleCountsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description:
        'A row for each language that at least one account or one subscription of the ' +
        'newsletters has, in the order of the codes, whether the shop answers in it now or not. A ' +
        'language nobody has is no row; the people with no language are no row either.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          locale: localeSchema,
          accounts: {
            type: 'integer',
            minimum: 0,
            description:
              'How many accounts that are not deleted have this language as their own (their ' +
              '`locale`).',
          },
          subscriptions: {
            type: 'integer',
            minimum: 0,
            description:
              'How many subscriptions of the newsletters have this language: the ones that wait ' +
              'for the confirmation, are in force, are paused after a complaint or stopped because ' +
              'the address does not exist, from the form and from accounts together. An ended ' +
              'subscription is not counted (it is the proof of a consent and keeps its language).',
          },
        },
        required: ['locale', 'accounts', 'subscriptions'],
      },
    },
  },
  required: ['items'],
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
  shopLocaleCountsResponseSchema,
  shopLogoFormSchema,
];

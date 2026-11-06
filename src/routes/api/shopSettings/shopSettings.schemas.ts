import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

// public: the fields a guest or a buyer is shown
const getPublicShopSettingsSchema = {
  operationId: 'getPublicShopSettings',
  summary: 'Get the public data of the shop',
  description:
    'The name and the logo of the shop, the seller it names (its legal name, address, tax id, ' +
    'email and phone, for the pages of the EU that need it), the languages its mails and its ' +
    'bot answer in. A field root has not set yet is null. Delivery is its own route ' +
    '(GET /api/delivery/methods).',

  response: {
    200: {
      description: 'The public data of the shop.',
      $ref: 'publicShopSettingsResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the data of the shop.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

export const shopSettingsSchemas = withOpenApiTag({ getPublicShopSettingsSchema }, 'shop-settings');

// admin, root: every current field, including the ones the public route leaves out
const getShopSettingsValuesSchema = {
  operationId: 'getShopSettingsValues',
  summary: 'Get every current field of the data of the shop',
  description:
    'The current value of every setting (the latest row of each), the server default for one ' +
    'root never set; a setting with no default of the server (deliveryCountries, the seller, the ' +
    'logo) is null, or an empty list, until root sets it (GET /api/admin/shop-settings/missing ' +
    'names which).',

  response: {
    200: {
      description: 'The current data of the shop.',
      $ref: 'shopSettingsValuesResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the data of the shop.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// admin, root: the fields with no default root has not set yet
const getShopSettingsMissingFieldsSchema = {
  operationId: 'getShopSettingsMissingFields',
  summary: 'Get the fields of the data of the shop root has not set yet',
  description:
    'The fields with no default of the server (deliveryCountries, the seller, the logo) still ' +
    'empty, and emailReplyTo while it is blank (no mail goes out without it); the same list the ' +
    'shop_settings_incomplete alert counts.',

  response: {
    200: {
      description: 'The fields still empty.',
      type: 'object',
      additionalProperties: false,
      properties: { fields: { type: 'array', items: { type: 'string' } } },
      required: ['fields'],
    },
    500: {
      description: 'Unexpected server error while reading the data of the shop.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

export const adminShopSettingsSchemas = withOpenApiSecurity(
  withOpenApiTag(
    {
      getShopSettingsValuesSchema,
      getShopSettingsMissingFieldsSchema,
    },
    'admin',
  ),
  openApiSecurity.accessTokenCookie,
);

// the refusals both writes share: nothing is written
const WRITE_REFUSALS =
  'Nothing is written. `VALIDATION_ERROR`: a value out of its shape (a price not above ' +
  'zero, below the cent or over 99999999.99, a list naming one value twice, a reply-to or a ' +
  'seller email that is not an address). The rules between settings, checked on the values the ' +
  'write would leave: `DELIVERY_FREE_FROM_WITHOUT_PRICE`: deliveryFreeFrom without ' +
  'deliveryFlatPrice. `PICKUP_DETAILS_REQUIRED`: the pickup method on with a blank ' +
  'pickupAddress or pickupHours (`details.fields` the blank ones). `PICKUP_HOURS_INVALID`: ' +
  'pickupHours not in its format (see the field). `RESERVATION_MINUTES_TOO_LONG`: ' +
  'reservationMinutes and stripePageMinutes together over a day (`details.max`, 1440). ' +
  '`SHOP_LOCALE_NOT_ENABLED`: shopLocale not among enabledLocales. ' +
  '`DELIVERY_COUNTRY_NOT_SUPPORTED`: a country of deliveryCountries the app does not know ' +
  'how to take a postal code of (`details.countries` the ones refused, `details.supported` ' +
  'the full list). `LOCALE_NOT_SUPPORTED`: a language of enabledLocales with no dictionary ' +
  '(`details.locales`/`details.supported`, src/locales).';

// root: every setting at once
const putShopSettingsSchema = {
  operationId: 'putShopSettings',
  summary: 'Set every setting of the data of the shop',
  description:
    'Every setting named, its value as it should be. A row is added for each setting whose ' +
    'value changes, none for one given as it already is; a row is never changed or removed, ' +
    'the latest row of a setting is its current value at once (the server keeps the values in ' +
    'memory, @config/shopSettings.js). The logo is not here, it has its own routes ' +
    '(POST and DELETE /api/root/shop-settings/logo).',

  body: { $ref: 'putShopSettingsBodySchema#' },

  response: {
    200: {
      description: 'The data of the shop after the write.',
      $ref: 'shopSettingsValuesResponseSchema#',
    },
    400: { description: WRITE_REFUSALS, $ref: 'errorResponseSchema#' },
    500: {
      description: 'Unexpected server error while writing the data of the shop.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// root: one setting
const putShopSettingSchema = {
  operationId: 'putShopSetting',
  summary: 'Set one setting of the data of the shop',
  description:
    'The value of one setting (`key`, a field of PUT /api/root/shop-settings), of the shape ' +
    'that field takes there: a row for it, none when it already has the value. The rules ' +
    'between settings are checked on the values with this one changed (a pickup turned on ' +
    'needs its address and hours set already, for example). The logo has its own routes.',

  params: { $ref: 'shopSettingKeyParamsSchema#' },
  body: { $ref: 'putShopSettingBodySchema#' },

  response: {
    200: {
      description: 'The data of the shop after the write.',
      $ref: 'shopSettingsValuesResponseSchema#',
    },
    400: {
      description: `A key that is not a setting root sets here (VALIDATION_ERROR). ${WRITE_REFUSALS}`,
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while writing the data of the shop.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// root: every row, the latest first
const getShopSettingsHistorySchema = {
  operationId: 'getShopSettingsHistory',
  summary: 'List the history of the data of the shop',
  description:
    'Every row of the settings, the latest first, or of one setting (`key`): the value it ' +
    'took, who set it (null for a row the server wrote to fill in a default) and when.',

  querystring: { $ref: 'shopSettingsHistoryQuerySchema#' },

  response: {
    200: {
      description: 'A page of rows.',
      $ref: 'shopSettingsHistoryResponseSchema#',
    },
    400: {
      description:
        'A limit out of range or a key that is no setting (VALIDATION_ERROR); CURSOR_INVALID.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while listing the history.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// root: sets the logo, or replaces the one the shop has
const postShopLogoSchema = {
  operationId: 'setShopLogo',
  summary: 'Set the logo of the shop',
  description:
    'Puts a logo on the shop, or replaces the one it has (the old file is deleted): a row of ' +
    'the logo. The body is a form with one file, `image`, a jpeg, png or webp file by its ' +
    'content.',

  response: {
    200: {
      description: 'The data of the shop with its logo.',
      $ref: 'shopSettingsValuesResponseSchema#',
    },
    400: {
      description:
        '`MULTIPART_REQUIRED`: the body is not a form. `SHOP_LOGO_REQUIRED`: the form has no ' +
        '`image` file. `SHOP_LOGO_MULTIPLE`: the form has more than one. ' +
        '`SHOP_LOGO_STREAM_ERROR`: an empty file. `IMAGE_TYPE_NOT_ALLOWED`: not a jpeg, png or ' +
        'webp file. `IMAGE_INVALID`: Cloudinary cannot read the file.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while setting the logo.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// root: takes the logo off the shop
const deleteShopLogoSchema = {
  operationId: 'removeShopLogo',
  summary: 'Take the logo off the shop',
  description: 'Takes the logo off the shop and deletes its file: a row of the logo with none.',

  response: {
    200: {
      description: 'The data of the shop without its logo.',
      $ref: 'shopSettingsValuesResponseSchema#',
    },
    409: {
      description: '`SHOP_LOGO_NOT_SET`: the shop has no logo.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while taking the logo off.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

export const rootShopSettingsSchemas = withOpenApiSecurity(
  withOpenApiTag(
    {
      putShopSettingsSchema,
      putShopSettingSchema,
      getShopSettingsHistorySchema,
      postShopLogoSchema,
      deleteShopLogoSchema,
    },
    'root',
  ),
  openApiSecurity.accessTokenCookie,
);

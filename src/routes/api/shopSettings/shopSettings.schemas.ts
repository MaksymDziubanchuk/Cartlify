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
    'The fields of the current version, the server default filling the ones root left empty; a ' +
    'field with no default of the server (deliveryCountries, the seller, the logo) is null until ' +
    'root sets it (GET /api/admin/shop-settings/missing names which).',

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

// admin, root: one field by its key
const getShopSettingsFieldSchema = {
  operationId: 'getShopSettingsField',
  summary: 'Get one current field of the data of the shop',
  description:
    'The key and the value of one field of the current version, null if root left it empty.',

  params: { $ref: 'shopSettingsFieldParamsSchema#' },

  response: {
    200: {
      description: 'The field.',
      $ref: 'shopSettingsFieldResponseSchema#',
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
      getShopSettingsFieldSchema,
    },
    'admin',
  ),
  openApiSecurity.accessTokenCookie,
);

// root: writes a full version
const putShopSettingsSchema = {
  operationId: 'putShopSettings',
  summary: 'Write a new version of the data of the shop',
  description:
    'Adds a new version with every field named (not a partial change): `baseVersion` is the ' +
    'version GET /api/root/shop-settings/history?limit=1 gave as the current one ' +
    '(`items[0].version`) when root opened the form to edit (0 before any version exists). ' +
    'The logo is not here, it has its own route ' +
    '(POST /api/root/shop-settings/logo) and is carried forward unchanged. A version is never ' +
    'changed or removed: this adds the next one, the current one becomes this one at once ' +
    '(the server keeps it in memory, @config/shopSettings.js).',

  body: { $ref: 'putShopSettingsBodySchema#' },

  response: {
    200: {
      description: 'The data of the shop after the write.',
      $ref: 'shopSettingsValuesResponseSchema#',
    },
    400: {
      description:
        'Nothing is written. `VALIDATION_ERROR`: a field out of its shape (a price not above ' +
        'zero, below the cent or over 99999999.99, a list naming one value twice, a reply-to or ' +
        'a seller email that is not an address). `DELIVERY_FREE_FROM_WITHOUT_PRICE`: ' +
        'deliveryFreeFrom without deliveryFlatPrice. `PICKUP_DETAILS_REQUIRED`: the pickup ' +
        'method is on with a blank pickupAddress or pickupHours (`details.fields` the blank ' +
        'ones). `RESERVATION_MINUTES_TOO_LONG`: reservationMinutes and stripePageMinutes ' +
        'together over a day (`details.max`, 1440). `SHOP_LOCALE_NOT_ENABLED`: shopLocale is ' +
        'not among enabledLocales. `DELIVERY_COUNTRY_NOT_SUPPORTED`: a country of ' +
        'deliveryCountries the app does not know how to take a postal code of ' +
        '(`details.countries` the ones refused, `details.supported` the full list). ' +
        '`LOCALE_NOT_SUPPORTED`: a language of enabledLocales with no dictionary ' +
        '(`details.locales`/`details.supported`, src/locales).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'Another write of root reached the database first (SHOP_SETTINGS_OUTDATED): read the ' +
        'current version again and edit from it.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while writing the data of the shop.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// root: every version, the latest first
const getShopSettingsHistorySchema = {
  operationId: 'getShopSettingsHistory',
  summary: 'List every version of the data of the shop',
  description:
    'Every version, the latest first, with who wrote it (null for a version the server wrote to ' +
    'fill in a default root left empty).',

  querystring: { $ref: 'shopSettingsHistoryQuerySchema#' },

  response: {
    200: {
      description: 'A page of versions.',
      $ref: 'shopSettingsHistoryResponseSchema#',
    },
    400: {
      description: 'A limit out of range (VALIDATION_ERROR); CURSOR_INVALID.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while listing the versions.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// root: sets the logo, or replaces the one the shop has
const postShopLogoSchema = {
  operationId: 'setShopLogo',
  summary: 'Set the logo of the shop',
  description:
    'Puts a logo on the shop, or replaces the one it has (the old file is deleted); a new ' +
    'version with the rest of the fields carried forward. The body is a form with one file, ' +
    '`image`, a jpeg, png or webp file by its content.',

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
  description: 'Takes the logo off the shop and deletes its file; a new version without it.',

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
      getShopSettingsHistorySchema,
      postShopLogoSchema,
      deleteShopLogoSchema,
    },
    'root',
  ),
  openApiSecurity.accessTokenCookie,
);

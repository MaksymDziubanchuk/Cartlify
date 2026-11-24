import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { idPathParam } from '@schemas/idPathParam.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

// root: the countries the shop sells to with the rule of their tax, and the tax groups of the
// products (docs/taxes.md)

const countryParams = {
  type: 'object',
  additionalProperties: false,
  required: ['country'],
  properties: {
    country: {
      type: 'string',
      pattern: '^[A-Z]{2}$',
      description: 'The country: two capital letters (ISO 3166-1 alpha-2).',
    },
  },
} as const;

const groupParams = {
  type: 'object',
  additionalProperties: false,
  required: ['groupId'],
  properties: { groupId: idPathParam('the tax group') },
} as const;

const SERVER_ERROR = {
  description: 'Unexpected server error.',
  $ref: 'errorResponseSchema#',
} as const;

// what a record may hold, by the database: the refusals of a write of a country
const RECORD_REFUSALS =
  'What a record holds, by its rule (docs/taxes.md): `SHOP_COUNTRY_RULE_INVALID`: a country with ' +
  'customs without the rule recipient or buyer_at_receipt, or buyer_at_receipt without customs. ' +
  '`SHOP_COUNTRY_RECIPIENT_ONLY`: the registration, its number, the limit of a parcel or the ' +
  'threshold without the rule recipient. `SHOP_COUNTRY_TAX_NUMBER_INVALID`: registered without ' +
  'the number, its label and its kind, or any of them without the registration. ' +
  '`SHOP_COUNTRY_THRESHOLD_INVALID`: an end of the threshold in the past. ' +
  '`SHOP_COUNTRY_RATES_REQUIRED`: the rule recipient without rates. `SHOP_COUNTRY_RATES_INVALID`: ' +
  'a group or the main rate without a rate from the start, or a group that starts twice at one ' +
  'time. `TAX_GROUP_NOT_FOUND`: a rate of a group that is not there. ' +
  '`SHOP_COUNTRY_GROUP_RATE_MISSING`: rates without a rate of every tax group. ' +
  '`SHOP_COUNTRY_EXPORT_PRICE_REQUIRED`, `SHOP_COUNTRY_EXEMPTION_TEXT_REQUIRED`: the rules none ' +
  'and buyer_at_receipt, and recipient across customs, without exportPrice or exemptionText. ' +
  '`SHOP_COUNTRY_DELIVERY_VAT_REQUIRED`: a rule that takes a tax, or a price without the tax of the ' +
  'seller, without deliveryVat. `SHOP_COUNTRY_PARCEL_LIMIT_INVALID`, ' +
  '`SHOP_COUNTRY_THRESHOLD_GROUP_MISMATCH`: the parts of a limit or of the threshold of a group ' +
  'apart (the schema and the write of the group keep them together).';

// the settings the write of a country is checked with, as it leaves them
const SETTINGS_REFUSALS =
  'The data of the shop, checked as the write leaves it (the same rules as PUT ' +
  '/api/root/shop-settings): `DELIVERY_ZONE_COUNTRY_REPEATED`, `DELIVERY_ZONE_NAME_REPEATED`, ' +
  '`DELIVERY_COUNTRY_NOT_SUPPORTED` (a country of a zone the app does not know a postal code ' +
  'of), `SHOP_COUNTRY_MISSING` (the pickupCountry without its record), ' +
  '`SELLER_COUNTRY_RATES_REQUIRED` (a shop that takes the tax: the record of its country without ' +
  'a main rate), `SHOP_COUNTRY_RULE_REQUIRED` (a shop that takes the tax: a country without ' +
  'customs without a rule, `details.countries`), and the other rules of the settings named there.';

// the receipts of the data of the shop a write of a country leaves as they are: refused once
// RECEIPT_PROVIDER of the server changed since root wrote receiptMoment
const RECEIPT_REFUSALS =
  'The fiscal receipts, when RECEIPT_PROVIDER of the server changed since root wrote ' +
  'receiptMoment (root writes it again first, PUT /api/root/shop-settings): ' +
  '`RECEIPT_MOMENT_REQUIRED`, `RECEIPT_MOMENT_WITHOUT_PROVIDER`, `RECEIPT_MOMENT_FIXED`, ' +
  '`RECEIPT_SELLER_COUNTRY_NOT_SUPPORTED`.';

const getShopCountriesSchema = {
  operationId: 'getShopCountries',
  summary: 'List the countries the shop sells to',
  description:
    'Every record of a country with its zone of the delivery (null: the shop does not deliver ' +
    'there, the record holds the rates of the seller or taxes a pickup), customs, the rule of the ' +
    'tax and what it needs, the rates with the planned ones, the threshold with the start of its ' +
    'period in force.',
  response: {
    200: { description: 'The countries.', $ref: 'getShopCountriesResponseSchema#' },
    500: SERVER_ERROR,
  },
} satisfies FastifySchema;

const getShopCountrySchema = {
  operationId: 'getShopCountry',
  summary: 'Get the record of a country',
  description: 'One record of a country as GET /api/root/countries lists it.',
  params: countryParams,
  response: {
    200: { description: 'The record.', $ref: 'shopCountryResponseSchema#' },
    404: {
      description: '`SHOP_COUNTRY_NOT_FOUND`: the shop has no record of the country.',
      $ref: 'errorResponseSchema#',
    },
    500: SERVER_ERROR,
  },
} satisfies FastifySchema;

const putShopCountrySchema = {
  operationId: 'putShopCountry',
  summary: 'Write a country the shop sells to, with its zone and its tax',
  description:
    'Everything a country is, at once, in one transaction: its zone of the delivery with the ' +
    'prices of the zone (the country leaves the zone it was in; a new name makes a zone, a zone ' +
    'left without a country goes), customs, the rule of the tax and what it needs, the rates. The ' +
    'threshold of a group is written for every country of the group. The code knows no law of ' +
    'any country: the numbers and the choices are what root writes. A new record or a changed ' +
    'one is in force for the next cart; a confirmed order keeps the tax it was confirmed with.',
  params: countryParams,
  body: { $ref: 'putShopCountryBodySchema#' },
  response: {
    200: { description: 'The record as written.', $ref: 'shopCountryResponseSchema#' },
    400: {
      description:
        'Nothing is written. `VALIDATION_ERROR`: a field out of its shape. ' +
        RECORD_REFUSALS +
        ' ' +
        SETTINGS_REFUSALS +
        ' ' +
        RECEIPT_REFUSALS,
      $ref: 'errorResponseSchema#',
    },
    500: SERVER_ERROR,
  },
} satisfies FastifySchema;

const deleteShopCountrySchema = {
  operationId: 'deleteShopCountry',
  summary: 'Take a country away',
  description:
    'The record goes with the place of the country in its zone (a zone left without a country ' +
    'goes); the orders confirmed to it keep their tax.',
  params: countryParams,
  response: {
    204: { description: 'The country is gone.', type: 'null' },
    400: {
      description:
        'Nothing is removed: the settings need the country. `SHOP_COUNTRY_MISSING`: it is the ' +
        'pickupCountry. `SELLER_COUNTRY_RATES_REQUIRED`: it is the country of a seller that takes ' +
        'the tax. ' +
        RECEIPT_REFUSALS,
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`SHOP_COUNTRY_NOT_FOUND`: the shop has no record of the country.',
      $ref: 'errorResponseSchema#',
    },
    500: SERVER_ERROR,
  },
} satisfies FastifySchema;

const postCopyExceptionsSchema = {
  operationId: 'postShopCountryCopyExceptions',
  summary: 'Copy the classes of the products from another country',
  description:
    'Every product another country classes in a group of its own (taxExceptions) gets the same ' +
    'class for this country, over what it had for it: a help for a new country whose law classes ' +
    'the products like that one. The products the other country does not name stay as they are.',
  params: countryParams,
  body: { $ref: 'postCopyExceptionsBodySchema#' },
  response: {
    200: {
      description: 'How many products were given the class.',
      $ref: 'postCopyExceptionsResponseSchema#',
    },
    400: {
      description: '`VALIDATION_ERROR`: not a country. `SHOP_COUNTRY_COPY_SAME`: the same country.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`SHOP_COUNTRY_NOT_FOUND`: the shop has no record of the country of the path.',
      $ref: 'errorResponseSchema#',
    },
    500: SERVER_ERROR,
  },
} satisfies FastifySchema;

const getTaxGroupsSchema = {
  operationId: 'getTaxGroups',
  summary: 'List the tax groups of the products',
  description:
    'The groups root named (books, medicines), with how many products are in each and how many ' +
    'a country classes in it. A product without a group takes the main rate of a country.',
  response: {
    200: { description: 'The groups, by name.', $ref: 'getTaxGroupsResponseSchema#' },
    500: SERVER_ERROR,
  },
} satisfies FastifySchema;

const postTaxGroupSchema = {
  operationId: 'postTaxGroup',
  summary: 'Make a tax group with its rates',
  description:
    'A new group with its rate in every country that has rates, in force from the start; a ' +
    'planned rate of the group is written with the country (PUT /api/root/countries/:country).',
  body: { $ref: 'postTaxGroupBodySchema#' },
  response: {
    201: { description: 'The group.', $ref: 'taxGroupResponseSchema#' },
    400: {
      description:
        'Nothing is written. `VALIDATION_ERROR`: a field out of its shape. ' +
        '`TAX_GROUP_RATES_MISSING`: a country with rates without the rate of the group ' +
        '(`details.countries`). `TAX_GROUP_RATES_UNKNOWN`: a rate for a country without rates ' +
        '(`details.countries`).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: '`TAX_GROUP_NAME_TAKEN`: a group of that name is there.',
      $ref: 'errorResponseSchema#',
    },
    500: SERVER_ERROR,
  },
} satisfies FastifySchema;

const patchTaxGroupSchema = {
  operationId: 'patchTaxGroup',
  summary: 'Rename a tax group',
  description: 'The name only; the rates are written with the countries.',
  params: groupParams,
  body: { $ref: 'patchTaxGroupBodySchema#' },
  response: {
    200: { description: 'The group.', $ref: 'taxGroupResponseSchema#' },
    400: {
      description: '`VALIDATION_ERROR`: a name out of its shape.',
      $ref: 'errorResponseSchema#',
    },
    404: { description: '`TAX_GROUP_NOT_FOUND`: no such group.', $ref: 'errorResponseSchema#' },
    409: {
      description: '`TAX_GROUP_NAME_TAKEN`: another group has that name.',
      $ref: 'errorResponseSchema#',
    },
    500: SERVER_ERROR,
  },
} satisfies FastifySchema;

const deleteTaxGroupSchema = {
  operationId: 'deleteTaxGroup',
  summary: 'Remove a tax group',
  description:
    'The group goes with its rates in the countries; the confirmed orders keep their tax.',
  params: groupParams,
  response: {
    204: { description: 'The group is gone.', type: 'null' },
    404: { description: '`TAX_GROUP_NOT_FOUND`: no such group.', $ref: 'errorResponseSchema#' },
    409: {
      description: '`TAX_GROUP_IN_USE`: a product is in the group, or a country classes one in it.',
      $ref: 'errorResponseSchema#',
    },
    500: SERVER_ERROR,
  },
} satisfies FastifySchema;

export const rootTaxesSchemas = withOpenApiSecurity(
  withOpenApiTag(
    {
      getShopCountriesSchema,
      getShopCountrySchema,
      putShopCountrySchema,
      deleteShopCountrySchema,
      postCopyExceptionsSchema,
      getTaxGroupsSchema,
      postTaxGroupSchema,
      patchTaxGroupSchema,
      deleteTaxGroupSchema,
    },
    'root',
  ),
  openApiSecurity.accessTokenCookie,
);

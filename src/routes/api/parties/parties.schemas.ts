import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const partyExample = {
  id: 7,
  name: 'Lampwerk GmbH',
  address: 'Lichtstrasse 4, 10115 Berlin, Germany',
  email: 'safety@lampwerk.example.com',
  country: 'DE',
  createdAt: '2026-10-31T10:00:00.000Z',
  updatedAt: '2026-10-31T10:00:00.000Z',
};

const partyDetailExample = { ...partyExample, usage: { manufacturerOf: 12, euResponsibleOf: 0 } };

const partyParamsExample = { partyId: '7' };

const namingProductsDetails =
  '`details`: `manufacturerOf` and `euResponsibleOf`, the ids of up to 20 products each, and `total`, ' +
  'how many products in all.';

const getPartiesSchema = {
  operationId: 'getParties',
  summary: 'Get the parties of the directory',
  description:
    'The manufacturers and the persons responsible in the EU that products name, by name (letter ' +
    'case ignored), with the number of products that name each. `q` finds a part of the name, the ' +
    'address or the email. For an admin or a root.',

  querystring: { $ref: 'partiesListQuerySchema#' },

  response: {
    200: {
      description: 'The page of parties.',
      $ref: 'partiesListResponseSchema#',
      examples: [{ items: [partyDetailExample], total: 1, limit: 50, nextCursor: null }],
    },
    400: {
      description: '`CURSOR_INVALID`: a cursor this route did not give, or one of another order.',
      $ref: 'errorResponseSchema#',
    },
    401: { description: 'Authentication is required.', $ref: 'errorResponseSchema#' },
    403: {
      description: 'Only an admin or a root reads the directory.',
      $ref: 'errorResponseSchema#',
    },
    500: { description: 'Unexpected server error.', $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const getPartySchema = {
  operationId: 'getParty',
  summary: 'Get a party of the directory',
  description: 'A party with the number of products that name it, the removed ones too.',

  params: { $ref: 'partiesParamsSchema#', examples: [partyParamsExample] },

  response: {
    200: {
      description: 'The party.',
      $ref: 'partiesDetailResponseSchema#',
      examples: [partyDetailExample],
    },
    401: { description: 'Authentication is required.', $ref: 'errorResponseSchema#' },
    403: {
      description: 'Only an admin or a root reads the directory.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`PARTY_NOT_FOUND`: there is no such party.',
      $ref: 'errorResponseSchema#',
    },
    500: { description: 'Unexpected server error.', $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const postPartySchema = {
  operationId: 'createParty',
  summary: 'Create a party',
  description:
    'Adds a manufacturer or a person responsible in the EU to the directory. All four values are ' +
    'required and kept trimmed, the country in capitals; one name, address and country is one row, ' +
    'letter case ignored.',

  body: {
    $ref: 'partiesCreateBodySchema#',
    examples: [
      {
        name: 'Lampwerk GmbH',
        address: 'Lichtstrasse 4, 10115 Berlin, Germany',
        email: 'safety@lampwerk.example.com',
        country: 'DE',
      },
    ],
  },

  response: {
    201: {
      description: 'The party was created.',
      $ref: 'partiesPartyResponseSchema#',
      examples: [partyExample],
    },
    400: {
      description:
        'A value is missing or empty (`PARTY_FIELDS_REQUIRED`), or wrong: too long, an email that is ' +
        'not one, a country that is not two letters (`PARTY_FIELDS_INVALID`); `details.fields` names ' +
        'the values.',
      $ref: 'errorResponseSchema#',
    },
    401: { description: 'Authentication is required.', $ref: 'errorResponseSchema#' },
    403: { description: 'Only an admin or a root creates parties.', $ref: 'errorResponseSchema#' },
    409: {
      description:
        '`PARTY_ALREADY_EXISTS`: the directory has this name, address and country; ' +
        '`details.partyId` is the party.',
      $ref: 'errorResponseSchema#',
    },
    500: { description: 'Unexpected server error.', $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const patchPartySchema = {
  operationId: 'updateParty',
  summary: 'Change a party',
  description:
    'Changes the values that are named. The party is one row for every product that names it, so the ' +
    'change shows in all of them. A country outside the EU is refused while a product has this ' +
    'party as its manufacturer with no person in the EU, or as its person in the EU.',

  params: { $ref: 'partiesParamsSchema#', examples: [partyParamsExample] },
  body: { $ref: 'partiesUpdateBodySchema#', examples: [{ address: 'Neue Strasse 9, Berlin' }] },

  response: {
    200: {
      description: 'The party after the change.',
      $ref: 'partiesPartyResponseSchema#',
      examples: [partyExample],
    },
    400: {
      description:
        'No value to change (`NO_FIELDS_TO_UPDATE`), or a value that was named is empty or wrong ' +
        '(`PARTY_FIELDS_INVALID`, `details.fields`).',
      $ref: 'errorResponseSchema#',
    },
    401: { description: 'Authentication is required.', $ref: 'errorResponseSchema#' },
    403: { description: 'Only an admin or a root changes parties.', $ref: 'errorResponseSchema#' },
    404: {
      description: '`PARTY_NOT_FOUND`: there is no such party.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`PARTY_ALREADY_EXISTS`: the change makes it the same as another party (`details.partyId`); ' +
        '`PARTY_COUNTRY_CHANGE_REFUSED`: the new country would break products. ' +
        namingProductsDetails,
      $ref: 'errorResponseSchema#',
    },
    500: { description: 'Unexpected server error.', $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const deletePartySchema = {
  operationId: 'deleteParty',
  summary: 'Delete a party',
  description: 'Takes a party out of the directory. A party that a product names stays.',

  params: { $ref: 'partiesParamsSchema#', examples: [partyParamsExample] },

  response: {
    200: {
      description: 'The party was deleted.',
      $ref: 'partiesDeleteResponseSchema#',
      examples: [{ message: 'Party deleted successfully.' }],
    },
    401: { description: 'Authentication is required.', $ref: 'errorResponseSchema#' },
    403: { description: 'Only an admin or a root deletes parties.', $ref: 'errorResponseSchema#' },
    404: {
      description: '`PARTY_NOT_FOUND`: there is no such party.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`PARTY_IN_USE`: a product names the party as its manufacturer or its person in the EU. ' +
        namingProductsDetails,
      $ref: 'errorResponseSchema#',
    },
    500: { description: 'Unexpected server error.', $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const taggedPartiesSchemas = withOpenApiTag(
  {
    getPartiesSchema,
    getPartySchema,
    postPartySchema,
    patchPartySchema,
    deletePartySchema,
  },
  'parties',
);

export const partiesSchema = withOpenApiSecurityFor(
  taggedPartiesSchemas,
  openApiSecurity.accessTokenCookie,
  [
    'getPartiesSchema',
    'getPartySchema',
    'postPartySchema',
    'patchPartySchema',
    'deletePartySchema',
  ],
);

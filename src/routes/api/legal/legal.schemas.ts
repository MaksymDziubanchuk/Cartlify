import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity, withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

// Schema for the versions in force
const getCurrentLegalDocumentsSchema = {
  operationId: 'getCurrentLegalDocuments',
  summary: 'Get the terms and the contract in force',
  description:
    'The latest version of the terms and of the contract, each with its text and the sha256 of ' +
    'it; a kind root has not published yet is left out, and then nothing of it is to accept. ' +
    'Everybody reads them, a guest too: the registration page shows them.',

  response: {
    200: {
      description: 'The versions in force.',
      $ref: 'legalDocumentsCurrentResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the versions.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const getLegalDocumentSchema = {
  operationId: 'getLegalDocument',
  summary: 'Get a version of the terms or of the contract',
  description: 'Any version by its id, one no longer in force too: what a customer accepted then.',

  params: { $ref: 'legalDocumentParamsSchema#' },

  response: {
    200: {
      description: 'The version with its text.',
      $ref: 'legalDocumentSchema#',
    },
    404: {
      description: 'No version with this id (LEGAL_DOCUMENT_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the version.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for what the customer accepted
const getLegalAcceptanceStatusSchema = {
  operationId: 'getLegalAcceptanceStatus',
  summary: 'Get what I accepted',
  description:
    'The versions in force, the version of each kind the customer accepted last and the kinds ' +
    'still to accept (`required`). The customer accepts at the registration; an account made ' +
    'by a provider, or a new version root published, needs POST /api/legal/acceptances before ' +
    'an order is confirmed.',

  response: {
    200: {
      description: 'What the customer accepted.',
      $ref: 'legalAcceptanceStatusSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the consents.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const acceptLegalDocumentsSchema = {
  operationId: 'acceptLegalDocuments',
  summary: 'Accept the versions in force',
  description:
    'Keeps the consent of the customer to each version named, with the address and the browser ' +
    'of the request; a version the customer accepted already is not kept again.',

  body: { $ref: 'legalAcceptBodySchema#' },

  response: {
    200: {
      description: 'What the customer accepted now.',
      $ref: 'legalAcceptanceStatusSchema#',
    },
    400: {
      description: 'No list, an id twice or not a whole number (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'A version that is not there (LEGAL_DOCUMENT_NOT_FOUND, `details.documentIds`).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A version that is no longer in force (LEGAL_VERSION_OUTDATED, `details.current` the ' +
        'versions in force `{ id, kind, version, title }`): the page shows them and the customer ' +
        'accepts again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while keeping the consent.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const taggedLegalSchemas = withOpenApiTag(
  {
    getCurrentLegalDocumentsSchema,
    getLegalDocumentSchema,
    getLegalAcceptanceStatusSchema,
    acceptLegalDocumentsSchema,
  },
  'legal',
);

// the consents need the session of the customer, the versions are public
export const legalSchemas = withOpenApiSecurityFor(
  taggedLegalSchemas,
  openApiSecurity.accessTokenCookie,
  ['getLegalAcceptanceStatusSchema', 'acceptLegalDocumentsSchema'],
);

// Schema for publishing a version (root)
const postRootLegalDocumentSchema = {
  operationId: 'publishLegalDocument',
  summary: 'Publish a version of the terms or of the contract',
  description:
    'Publishes the next version of the kind, in force at once for every customer: an order is ' +
    'confirmed only by a customer who accepted it. The database numbers the versions of each ' +
    'kind and keeps the sha256 of the text; nobody changes or takes a version away, the next one ' +
    'replaces it. The text of the version an order is confirmed with goes to the buyer as a file ' +
    'of the mail of the payment, the copy of the contract: the terms and the contract together ' +
    'have to give what a buyer must have in it, the right to withdraw within 14 days, how to ' +
    'withdraw and return the goods and who pays for the return, and the model withdrawal form.',

  body: { $ref: 'legalDocumentPublishBodySchema#' },

  response: {
    201: {
      description: 'The version published.',
      $ref: 'legalDocumentSchema#',
    },
    400: {
      description:
        'A kind there is not, a title or a text too long or empty (VALIDATION_ERROR); a title ' +
        'or a text of spaces only (LEGAL_DOCUMENT_EMPTY).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while publishing the version.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const getRootLegalDocumentsSchema = {
  operationId: 'listLegalDocuments',
  summary: 'List every version of the terms and of the contract',
  description: 'Every version, the latest first, without its text, with who published it.',

  querystring: { $ref: 'legalDocumentsHistoryQuerySchema#' },

  response: {
    200: {
      description: 'A page of versions.',
      $ref: 'legalDocumentsHistoryResponseSchema#',
    },
    400: {
      description: 'A kind there is not, a limit out of range (VALIDATION_ERROR); CURSOR_INVALID.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while listing the versions.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

export const rootLegalSchemas = withOpenApiSecurity(
  withOpenApiTag({ postRootLegalDocumentSchema, getRootLegalDocumentsSchema }, 'root'),
  openApiSecurity.accessTokenCookie,
);

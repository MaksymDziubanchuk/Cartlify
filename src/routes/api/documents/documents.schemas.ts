import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { MAX_DOCUMENT_SIZE_BYTES } from '@config/limits.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const documentExample = {
  id: 3,
  title: 'User manual',
  kind: 'instruction',
  url: 'https://res.cloudinary.com/demo/image/upload/v1712345678/prod/documents/0b6c7f1e-7d3a-4c1f-9a64-2f0e5b8d1c33.pdf',
  sizeBytes: 482113,
  createdAt: '2026-10-31T10:00:00.000Z',
  updatedAt: '2026-10-31T10:00:00.000Z',
};

const documentDetailExample = { ...documentExample, usage: { products: 12 } };

const documentParamsExample = { documentId: '3' };

const unauthorized = { description: 'Authentication is required.', $ref: 'errorResponseSchema#' };
const forbidden = {
  description: 'Only an admin or a root keeps the documents.',
  $ref: 'errorResponseSchema#',
};
const serverError = { description: 'Unexpected server error.', $ref: 'errorResponseSchema#' };
const notFound = {
  description: '`DOCUMENT_NOT_FOUND`: there is no such document.',
  $ref: 'errorResponseSchema#',
};

const getDocumentsSchema = {
  operationId: 'getDocuments',
  summary: 'Get the documents of the directory',
  description:
    'The documents (instructions, certificates, declarations) that products name, by title (letter ' +
    'case ignored), with the number of products that name each. `q` finds a part of the title. For ' +
    'an admin or a root.',

  querystring: { $ref: 'documentsListQuerySchema#' },

  response: {
    200: {
      description: 'The page of documents.',
      $ref: 'documentsListResponseSchema#',
      examples: [{ items: [documentDetailExample], total: 1, limit: 50, nextCursor: null }],
    },
    400: {
      description: '`CURSOR_INVALID`: a cursor this route did not give, or one of another order.',
      $ref: 'errorResponseSchema#',
    },
    401: unauthorized,
    403: forbidden,
    500: serverError,
  },
} satisfies FastifySchema;

const getDocumentSchema = {
  operationId: 'getDocument',
  summary: 'Get a document of the directory',
  description: 'A document with the number of products that name it.',

  params: { $ref: 'documentsParamsSchema#', examples: [documentParamsExample] },

  response: {
    200: {
      description: 'The document.',
      $ref: 'documentsDetailResponseSchema#',
      examples: [documentDetailExample],
    },
    401: unauthorized,
    403: forbidden,
    404: notFound,
    500: serverError,
  },
} satisfies FastifySchema;

const postDocumentSchema = {
  operationId: 'createDocument',
  summary: 'Create a document',
  description:
    'Keeps a PDF file as a document of the directory, from a multipart form: the file in `file`, ' +
    'the `title` and the `kind`. The file is a PDF by its first bytes, whatever type the form names, ' +
    `up to ${MAX_DOCUMENT_SIZE_BYTES / 1_000_000} MB; it is kept on Cloudinary as a pdf, and the ` +
    '`url` of the answer opens it. A refused request keeps no file. Products name documents by ' +
    'their ids (`documentIds`).',

  response: {
    201: {
      description: 'The document was created.',
      $ref: 'documentsDocumentResponseSchema#',
      examples: [documentExample],
    },
    400: {
      description:
        'Not a form (`MULTIPART_REQUIRED`), no file (`DOCUMENT_REQUIRED`), more than one file ' +
        '(`DOCUMENT_MULTIPLE`), an empty file (`DOCUMENT_STREAM_ERROR`), a file that is not a PDF by ' +
        'its bytes or whose type the form names is not application/pdf (`DOCUMENT_TYPE_NOT_ALLOWED`), ' +
        'a file that starts as a PDF but has no page to read (`DOCUMENT_INVALID`), ' +
        'a title that is missing or blank (`DOCUMENT_TITLE_REQUIRED`) or too long ' +
        '(`DOCUMENT_TITLE_TOO_LONG`, `details.max`), a kind that is missing or not one of the four ' +
        '(`DOCUMENT_KIND_INVALID`, `details.allowed`), a text of the form with a NUL sign ' +
        '(`TEXT_NUL_FORBIDDEN`).',
      $ref: 'errorResponseSchema#',
    },
    401: unauthorized,
    403: forbidden,
    413: {
      description: '`PAYLOAD_TOO_LARGE`: the file is bigger than the limit of a document.',
      $ref: 'errorResponseSchema#',
    },
    500: serverError,
  },
} satisfies FastifySchema;

const patchDocumentSchema = {
  operationId: 'updateDocument',
  summary: 'Change a document',
  description:
    'Changes the title and the kind of a document; its file stays. The change shows in every product ' +
    'that names the document.',

  params: { $ref: 'documentsParamsSchema#', examples: [documentParamsExample] },
  body: { $ref: 'documentsUpdateBodySchema#', examples: [{ title: 'Safety certificate' }] },

  response: {
    200: {
      description: 'The document after the change.',
      $ref: 'documentsDocumentResponseSchema#',
      examples: [documentExample],
    },
    400: {
      description:
        'No value to change (`NO_FIELDS_TO_UPDATE`), a blank title (`DOCUMENT_TITLE_REQUIRED`) or a ' +
        'title that is too long (`DOCUMENT_TITLE_TOO_LONG`, `details.max`).',
      $ref: 'errorResponseSchema#',
    },
    401: unauthorized,
    403: forbidden,
    404: notFound,
    500: serverError,
  },
} satisfies FastifySchema;

const deleteDocumentSchema = {
  operationId: 'deleteDocument',
  summary: 'Delete a document',
  description:
    'Takes a document out of the directory and deletes its file. A document that a product names stays.',

  params: { $ref: 'documentsParamsSchema#', examples: [documentParamsExample] },

  response: {
    200: {
      description: 'The document was deleted.',
      $ref: 'documentsDeleteResponseSchema#',
      examples: [{ message: 'Document deleted successfully.' }],
    },
    401: unauthorized,
    403: forbidden,
    404: notFound,
    409: {
      description:
        '`DOCUMENT_IN_USE`: a product names the document. `details`: `productIds`, the ids of up to ' +
        '20 products, and `total`, how many products name it.',
      $ref: 'errorResponseSchema#',
    },
    500: serverError,
  },
} satisfies FastifySchema;

const taggedDocumentsSchemas = withOpenApiTag(
  {
    getDocumentsSchema,
    getDocumentSchema,
    postDocumentSchema,
    patchDocumentSchema,
    deleteDocumentSchema,
  },
  'documents',
);

export const documentsSchema = withOpenApiSecurityFor(
  taggedDocumentsSchemas,
  openApiSecurity.accessTokenCookie,
  [
    'getDocumentsSchema',
    'getDocumentSchema',
    'postDocumentSchema',
    'patchDocumentSchema',
    'deleteDocumentSchema',
  ],
);

import { DOCUMENT_KINDS, DOCUMENT_TITLE_MAX } from '@helpers/documentFields.js';
import { MAX_DOCUMENT_SIZE_BYTES } from '@config/limits.js';
import { idPathParam } from '@schemas/idPathParam.js';

// the title is checked by the service, which names a missing or long one with a code of its own;
// the kind is an enum here, a form (which is not checked against a schema) is checked by the service

const titleDescription = `The title of the document, up to ${DOCUMENT_TITLE_MAX} signs, kept trimmed.`;
const kindField = {
  type: 'string',
  enum: [...DOCUMENT_KINDS],
  description: 'What the document is: an instruction, a certificate, a declaration or other.',
} as const;

export const documentsParamsSchema = {
  $id: 'documentsParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: { documentId: idPathParam('the document') },
  required: ['documentId'],
} as const;

// documentation only: the form of POST /api/admin/documents, which the controller reads
const documentsCreateFormSchema = {
  $id: 'documentsCreateFormSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    file: {
      type: 'string',
      format: 'binary',
      description: `The PDF file, up to ${MAX_DOCUMENT_SIZE_BYTES / 1_000_000} MB, a pdf by its bytes (DOCUMENT_TYPE_NOT_ALLOWED). One file only (DOCUMENT_MULTIPLE).`,
    },
    title: { type: 'string', description: titleDescription },
    kind: kindField,
  },
  required: ['file', 'title', 'kind'],
} as const;

const documentsUpdateBodySchema = {
  $id: 'documentsUpdateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: titleDescription },
    kind: kindField,
  },
} as const;

const documentsListQuerySchema = {
  $id: 'documentsListQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'The most rows a page holds, from 1 to 100.',
    },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'The nextCursor of the previous page, with the same filters and sort.',
    },
    q: { type: 'string', maxLength: 200, description: 'A part of the title, letter case ignored.' },
    kind: kindField,
    sortOrder: {
      type: 'string',
      enum: ['asc', 'desc'],
      default: 'asc',
      description: 'The order of the titles, asc by default.',
    },
  },
} as const;

const documentFields = {
  id: { type: 'integer' },
  title: { type: 'string' },
  kind: kindField,
  url: { type: 'string', description: 'Where the PDF opens.' },
  sizeBytes: { type: 'integer' },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
} as const;

const documentRequired = ['id', 'title', 'kind', 'url', 'sizeBytes', 'createdAt', 'updatedAt'];

const documentsDocumentResponseSchema = {
  $id: 'documentsDocumentResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: documentFields,
  required: documentRequired,
} as const;

const documentsDetailResponseSchema = {
  $id: 'documentsDetailResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...documentFields,
    usage: {
      type: 'object',
      additionalProperties: false,
      description: 'How many products name the document.',
      properties: { products: { type: 'integer' } },
      required: ['products'],
    },
  },
  required: [...documentRequired, 'usage'],
} as const;

const documentsListResponseSchema = {
  $id: 'documentsListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'documentsDetailResponseSchema#' } },
    total: { type: 'integer', description: 'How many documents match, whatever the page.' },
    limit: { type: 'integer' },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'total', 'limit', 'nextCursor'],
} as const;

const documentsDeleteResponseSchema = {
  $id: 'documentsDeleteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: { message: { type: 'string' } },
  required: ['message'],
} as const;

export const documentsDtoSchemas = [
  documentsParamsSchema,
  documentsCreateFormSchema,
  documentsUpdateBodySchema,
  documentsListQuerySchema,
  documentsDocumentResponseSchema,
  documentsDetailResponseSchema,
  documentsListResponseSchema,
  documentsDeleteResponseSchema,
];

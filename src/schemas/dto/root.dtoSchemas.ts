import { avatarIsDefaultField, avatarUrlsField } from '@schemas/avatarFields.js';
import { idPathParam } from '@schemas/idPathParam.js';

const rootAdminsGetQuerySchema = {
  $id: 'rootAdminsGetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' },
    search: { type: 'string' },
  },
} as const;

// an admin of the list of root; a deleted admin keeps the role and has its deletedAt
const rootAdminsItemSchema = {
  $id: 'rootAdminsItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['USER', 'ADMIN', 'ROOT'] },
    isVerified: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    name: { type: 'string' },
    avatarUrls: avatarUrlsField,
    avatarIsDefault: avatarIsDefaultField,
    locale: { type: 'string' },
    phone: { type: 'string' },
    deletedAt: {
      type: ['string', 'null'],
      format: 'date-time',
      description: 'When the account was deleted; null for a working admin.',
    },
  },
  required: [
    'id',
    'email',
    'role',
    'isVerified',
    'createdAt',
    'updatedAt',
    'avatarUrls',
    'avatarIsDefault',
    'deletedAt',
  ],
} as const;

const rootAdminsGetResponseSchema = {
  $id: 'rootAdminsGetResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'rootAdminsItemSchema#' } },
    limit: { type: 'number' },
    nextCursor: {
      anyOf: [{ type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' }, { type: 'null' }],
    },
    total: { type: 'number' },
  },
  required: ['items', 'limit', 'total'],
} as const;

const rootAdminsAddBodySchema = {
  $id: 'rootAdminsAddBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: { type: 'number' },
  },
  required: ['userId'],
} as const;

const rootAdminsAddResponseSchema = {
  $id: 'rootAdminsAddResponseSchema',
  allOf: [{ $ref: 'usersUserResponseSchema#' }],
} as const;

const rootAdminsDeleteParamsSchema = {
  $id: 'rootAdminsDeleteParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    adminId: idPathParam('the admin'),
  },
  required: ['adminId'],
} as const;

const rootAdminsDeleteResponseSchema = {
  $id: 'rootAdminsDeleteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
} as const;

export const rootAdminsDtoSchemas = [
  rootAdminsGetQuerySchema,
  rootAdminsItemSchema,
  rootAdminsGetResponseSchema,
  rootAdminsAddBodySchema,
  rootAdminsAddResponseSchema,
  rootAdminsDeleteParamsSchema,
  rootAdminsDeleteResponseSchema,
];

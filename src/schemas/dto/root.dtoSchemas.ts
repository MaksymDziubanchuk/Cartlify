import { avatarIsDefaultField, avatarUrlsField } from '@schemas/avatarFields.js';
import { canManageMoneyField } from '@schemas/moneyManagerField.js';
import { canManageNewslettersField } from '@schemas/newsletterManagerField.js';
import { idPathParam } from '@schemas/idPathParam.js';

const rootAdminsGetQuerySchema = {
  $id: 'rootAdminsGetQuerySchema',
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
      description: 'The nextCursor of the previous page.',
    },
    search: {
      type: 'string',
      description: 'A part of the email or the name, letter case ignored.',
    },
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
    canManageNewsletters: {
      ...canManageNewslettersField,
      description:
        'May the admin run the newsletters: true when root gave the right and the account is ' +
        'not deleted, false otherwise (a deleted admin has no right, whatever was kept). Root ' +
        'gives and takes it with PATCH /api/root/admins/{adminId}; it goes away when the person ' +
        'stops being an admin and does not come back when root makes them an admin again.',
    },
    canManageMoney: {
      ...canManageMoneyField,
      description:
        'May the admin handle the money the way root does: true when root gave the right and ' +
        'the account is not deleted, false otherwise (a deleted admin has no right, whatever ' +
        'was kept). Root gives and takes it with PATCH /api/root/admins/{adminId}; it goes away ' +
        'when the person stops being an admin and does not come back when root makes them an ' +
        'admin again.',
    },
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
    'canManageNewsletters',
    'canManageMoney',
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

const rootAdminsUpdateParamsSchema = {
  $id: 'rootAdminsUpdateParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    adminId: idPathParam('the admin'),
  },
  required: ['adminId'],
} as const;

const rootAdminsUpdateBodySchema = {
  $id: 'rootAdminsUpdateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    canManageNewsletters: {
      // a list of the two values and no type: the server turns a value into the type of the schema
      // (coerceTypes), so a boolean type would take 1, "true" and null; a right is given by a
      // boolean only
      enum: [true, false],
      description:
        'A JSON boolean, nothing else is taken (1, "true" and null are refused). true gives the admin the right to run the newsletters (subscribers, the list of ' +
        'blocked addresses, newsletters), false takes it away. It works at once, also in a ' +
        'session that is open. The same value again changes nothing and writes nothing to the ' +
        'admin log.',
    },
    canManageMoney: {
      enum: [true, false],
      description:
        'A JSON boolean, nothing else is taken (1, "true" and null are refused). true gives the ' +
        'admin the right to handle the money the way root does (money sent outside the app, rows ' +
        'of a statement closed without money, the decisions on refunds made by hand and on the ' +
        'money of a bank, the holds root lets go), false takes it away. It works at once, also ' +
        'in a session that is open. The same value again changes nothing and writes nothing to ' +
        'the admin log.',
    },
  },
  // at least one of the two rights
  minProperties: 1,
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
  rootAdminsUpdateParamsSchema,
  rootAdminsUpdateBodySchema,
  rootAdminsDeleteParamsSchema,
  rootAdminsDeleteResponseSchema,
];

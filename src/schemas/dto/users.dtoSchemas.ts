import { MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';
import { PHONE_PATTERN, PROFILE_TEXT_MAX_LENGTH } from '@helpers/profileText.js';
import { idPathParam } from '@schemas/idPathParam.js';

const usersGetByIdParamsSchema = {
  $id: 'usersGetByIdParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: idPathParam('the user'),
  },
  required: ['userId'],
} as const;

const usersUserReviewResponseSchema = {
  $id: 'usersUserReviewResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    productId: { type: 'number' },
    rating: { type: 'number' },
    userId: { type: 'number' },
    createdAt: { type: 'string', format: 'date-time' },

    comment: { type: 'string' },

    upVotes: { type: 'number' },
    downVotes: { type: 'number' },
    userVote: {
      anyOf: [{ type: 'string', enum: ['up', 'down'] }, { type: 'null' }],
    },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'productId',
    'rating',
    'userId',
    'createdAt',
    'comment',
    'upVotes',
    'downVotes',
    'userVote',
    'updatedAt',
  ],
} as const;

const usersUserResponseSchema = {
  $id: 'usersUserResponseSchema',
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
    avatarUrls: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url32: { type: 'string' },
        url64: { type: 'string' },
        url128: { type: 'string' },
        url256: { type: 'string' },
      },
      required: ['url32', 'url64', 'url128', 'url256'],
    },
    locale: { type: 'string' },
    phone: { type: 'string' },

    reviews: {
      type: 'array',
      items: { $ref: 'usersUserReviewResponseSchema#' },
    },
  },
  required: ['id', 'email', 'role', 'isVerified', 'createdAt', 'updatedAt'],
} as const;

const usersGetMeResponseSchema = {
  $id: 'usersGetMeResponseSchema',
  allOf: [{ $ref: 'usersUserResponseSchema#' }],
} as const;

// public profile of any user: no email, the user sees their own one in usersGetMeResponseSchema
const usersGetByIdResponseSchema = {
  $id: 'usersGetByIdResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },

    name: { type: 'string' },
    avatarUrls: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url32: { type: 'string' },
        url64: { type: 'string' },
        url128: { type: 'string' },
        url256: { type: 'string' },
      },
      required: ['url32', 'url64', 'url128', 'url256'],
    },
    deletedAt: {
      type: 'string',
      format: 'date-time',
      description:
        'When the account was deleted. Only an admin or root reads a deleted account, ' +
        'for anyone else it is USER_NOT_FOUND.',
    },
  },
  required: ['id', 'createdAt', 'updatedAt'],
} as const;

// the fields of the update, shared by the json body and the form
const profileNameField = {
  type: 'string',
  maxLength: PROFILE_TEXT_MAX_LENGTH,
  description: `Display name, up to ${PROFILE_TEXT_MAX_LENGTH} characters. Spaces around it are cut; an empty value removes the name.`,
} as const;

const profileLocaleField = {
  type: 'string',
  maxLength: PROFILE_TEXT_MAX_LENGTH,
  description: `Locale of the user, for example en or uk-UA, up to ${PROFILE_TEXT_MAX_LENGTH} characters. An empty value removes the locale.`,
} as const;

// empty removes the phone; a non-empty one is an international number and nothing else
const profilePhoneField = {
  type: 'string',
  maxLength: 16,
  pattern: `^(${PHONE_PATTERN})?$`,
  description:
    'Phone in the international format: a plus sign and 8 to 15 digits, the first one not zero, ' +
    'for example +380501234567. No spaces, brackets or dashes. An empty value removes the phone.',
} as const;

// the json body; a file cannot travel in json, the avatar goes in the form below
const usersUpdateMeBodySchema = {
  $id: 'usersUpdateMeBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: profileNameField,
    locale: profileLocaleField,
    phone: profilePhoneField,
  },
} as const;

// the same update as a multipart form with an avatar file. A request is never validated against
// this schema (a form skips validation, the service holds the rules): it is here for the docs
const usersUpdateMeFormSchema = {
  $id: 'usersUpdateMeFormSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: profileNameField,
    locale: profileLocaleField,
    phone: profilePhoneField,
    avatar: {
      type: 'string',
      format: 'binary',
      description: `Avatar image: a jpeg, png or webp file, up to ${MAX_UPLOAD_SIZE_BYTES / 1_000_000} MB. One file only.`,
    },
  },
} as const;

// the own account goes: a local one confirms with the password, the open orders with a flag
const usersDeleteMeBodySchema = {
  $id: 'usersDeleteMeBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    password: {
      type: 'string',
      maxLength: 256,
      description:
        'The password of a local account, required for it; an account of Google, GitHub or ' +
        'LinkedIn has none and sends nothing here. Spaces at the start and the end are dropped.',
    },
    confirmOpenOrders: {
      type: 'boolean',
      description:
        'true deletes the account although it has orders waiting for payment, paid or shipped, ' +
        'after the user saw them in the ACCOUNT_HAS_OPEN_ORDERS answer.',
    },
  },
} as const;

const usersDeleteMeResponseSchema = {
  $id: 'usersDeleteMeResponseSchema',
  type: 'null',
} as const;

const usersUpdateMeResponseSchema = {
  $id: 'usersUpdateMeResponseSchema',
  allOf: [{ $ref: 'usersUserResponseSchema#' }],
} as const;

export const usersDtoSchemas = [
  usersGetByIdParamsSchema,
  usersUserResponseSchema,
  usersUserReviewResponseSchema,
  usersGetMeResponseSchema,
  usersGetByIdResponseSchema,
  usersUpdateMeBodySchema,
  usersUpdateMeFormSchema,
  usersUpdateMeResponseSchema,
  usersDeleteMeBodySchema,
  usersDeleteMeResponseSchema,
];

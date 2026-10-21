import { MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';
import { PHONE_PATTERN, PROFILE_TEXT_MAX_LENGTH } from '@helpers/profileText.js';
import { idPathParam } from '@schemas/idPathParam.js';
import {
  PROFILE_LISTS,
  PROFILE_PERIOD_DEFAULT_DAYS,
  PROFILE_PERIOD_MAX_DAYS,
} from '@routes/api/users/services/helpers/adminProfile.helper.js';
import {
  USERS_LIST_DEFAULT_LIMIT,
  USERS_LIST_PROVIDERS,
  USERS_LIST_ROLES,
  USERS_LIST_SORT_FIELDS,
  USERS_LIST_SORT_ORDERS,
} from '@routes/api/users/services/helpers/usersList.helper.js';

const usersGetByIdParamsSchema = {
  $id: 'usersGetByIdParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: idPathParam('the user'),
  },
  required: ['userId'],
} as const;

const profileListName = `(${PROFILE_LISTS.join('|')})`;

// the checkboxes of the admin page and the period of the lists; a user's are ignored
const usersGetByIdQuerySchema = {
  $id: 'usersGetByIdQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    include: {
      type: 'string',
      pattern: `^${profileListName}(,${profileListName})*$`,
      description:
        `For an admin or root: the lists to give, comma separated: ${PROFILE_LISTS.join(', ')}. ` +
        'Without it the profile has no list. Ignored for a user.',
    },
    from: {
      type: 'string',
      format: 'date-time',
      description:
        `For an admin or root: the start of the period of the lists, ${PROFILE_PERIOD_DEFAULT_DAYS} ` +
        `days before to unless given. At most ${PROFILE_PERIOD_MAX_DAYS} days to to. Ignored for a user.`,
    },
    to: {
      type: 'string',
      format: 'date-time',
      description: 'For an admin or root: the end of the period of the lists, now unless given.',
    },
  },
} as const;

const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;

// the lists of the profile an admin reads, each one of the period, newest first
const usersAdminProfileListsSchema = {
  orders: {
    type: 'array',
    description: 'Orders of the user created in the period, the cart included.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number' },
        status: {
          type: 'string',
          enum: ['pending', 'unconfirmed', 'waiting', 'paid', 'shipped', 'delivered', 'cancelled'],
        },
        total: { type: 'number' },
        createdAt: dateTime,
        updatedAt: dateTime,
      },
      required: ['id', 'status', 'total', 'createdAt', 'updatedAt'],
    },
  },
  reviews: {
    type: 'array',
    description: 'Reviews the user wrote in the period.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number' },
        productId: { type: 'number' },
        rating: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        comment: nullableString,
        upVotes: { type: 'number' },
        downVotes: { type: 'number' },
        createdAt: dateTime,
        updatedAt: dateTime,
      },
      required: [
        'id',
        'productId',
        'rating',
        'comment',
        'upVotes',
        'downVotes',
        'createdAt',
        'updatedAt',
      ],
    },
  },
  favorites: {
    type: 'array',
    description: 'Products the user added to favorites in the period.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'number' }, productId: { type: 'number' }, createdAt: dateTime },
      required: ['id', 'productId', 'createdAt'],
    },
  },
  votes: {
    type: 'array',
    description: 'Votes of the user for reviews of other users, given in the period.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number' },
        reviewId: { type: 'number' },
        action: { type: 'string', enum: ['up', 'down'] },
        createdAt: dateTime,
      },
      required: ['id', 'reviewId', 'action', 'createdAt'],
    },
  },
  loginLogs: {
    type: 'array',
    description: 'Logins of the user in the period.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number' },
        createdAt: dateTime,
        ipAddress: nullableString,
        userAgent: nullableString,
      },
      required: ['id', 'createdAt', 'ipAddress', 'userAgent'],
    },
  },
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
    // null in the enum too: swagger shows the field as nullable, and openapi 3.0 lets null
    // through a nullable enum only when the enum names it
    userVote: { type: 'string', enum: ['up', 'down', null], nullable: true },
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

// the profile of any user. A user gets id, the dates, the name and the avatar, no email (the own
// one is in usersGetMeResponseSchema); an admin or root gets the fields marked so as well
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

    email: { type: 'string', format: 'email', description: 'Admin or root only.' },
    role: { type: 'string', enum: ['USER', 'ADMIN', 'ROOT'], description: 'Admin or root only.' },
    authProvider: {
      type: 'string',
      enum: ['LOCAL', 'GOOGLE', 'GITHUB', 'LINKEDIN'],
      description: 'Admin or root only: how the account logs in.',
    },
    isVerified: { type: 'boolean', description: 'Admin or root only.' },
    locale: { type: 'string', description: 'Admin or root only, when set.' },
    phone: { type: 'string', description: 'Admin or root only, when set.' },
    openChatThreadId: {
      anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
      description:
        'Admin or root only: the open chat of the user with an admin, ' +
        'GET /api/chat/admin/threads/{threadId} opens it; null when there is none.',
    },
    period: {
      type: 'object',
      additionalProperties: false,
      description: 'Admin or root only: the period the lists cover.',
      properties: { from: dateTime, to: dateTime },
      required: ['from', 'to'],
    },
    ...usersAdminProfileListsSchema,
  },
  required: ['id', 'createdAt', 'updatedAt'],
} as const;

// one name of the list or several through commas
const namesPattern = (names: readonly string[]) => {
  const one = `(${names.join('|')})`;
  return `^${one}(,${one})*$`;
};

// the filters, the email search and the order of the admin table of users
const usersListQuerySchema = {
  $id: 'usersListQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: `Rows on a page, ${USERS_LIST_DEFAULT_LIMIT} unless given.`,
    },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description:
        'nextCursor of the page before. It holds the order it was given for: with another sortBy ' +
        'or sortOrder it is CURSOR_INVALID.',
    },
    email: {
      type: 'string',
      maxLength: 254,
      description:
        'A part of the email, in any case; spaces around it are cut, _ and % are the characters ' +
        'themselves. A deleted account has the address deleted+<id>+...@<domain of the site>.',
    },
    role: {
      type: 'string',
      pattern: namesPattern(USERS_LIST_ROLES),
      description: `Roles, one or several through commas: ${USERS_LIST_ROLES.join(', ')}. All unless given.`,
    },
    authProvider: {
      type: 'string',
      pattern: namesPattern(USERS_LIST_PROVIDERS),
      description: `How the account logs in, one or several through commas: ${USERS_LIST_PROVIDERS.join(', ')}. All unless given.`,
    },
    isVerified: {
      type: 'boolean',
      description: 'true: only the accounts with a confirmed email, false: only the others.',
    },
    deleted: {
      type: 'boolean',
      description:
        'true lists only deleted accounts. Without it, or with false, the accounts that are not deleted.',
    },
    sortBy: {
      type: 'string',
      enum: USERS_LIST_SORT_FIELDS,
      description:
        'createdAt (the sign-up, unless given) or lastLoginAt. Equal values go by id; accounts that ' +
        'never logged in come last in either order.',
    },
    sortOrder: {
      type: 'string',
      enum: USERS_LIST_SORT_ORDERS,
      description: 'desc (the newest first, unless given) or asc.',
    },
  },
} as const;

const avatarUrlsObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url32: { type: 'string' },
    url64: { type: 'string' },
    url128: { type: 'string' },
    url256: { type: 'string' },
  },
  required: ['url32', 'url64', 'url128', 'url256'],
} as const;

const nullableDateTime = { anyOf: [dateTime, { type: 'null' }] } as const;

// a row of the admin table: every field is there, null when the account has none
const usersListItemSchema = {
  $id: 'usersListItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    email: { type: 'string', format: 'email' },
    name: nullableString,
    role: { type: 'string', enum: USERS_LIST_ROLES },
    authProvider: { type: 'string', enum: USERS_LIST_PROVIDERS },
    isVerified: { type: 'boolean' },
    locale: nullableString,
    avatarUrls: { anyOf: [avatarUrlsObject, { type: 'null' }] },
    createdAt: dateTime,
    updatedAt: dateTime,
    lastLoginAt: {
      ...nullableDateTime,
      description: 'The last login, null for an account that never logged in.',
    },
    deletedAt: {
      ...nullableDateTime,
      description: 'When the account was deleted, null for a live one.',
    },
  },
  required: [
    'id',
    'email',
    'name',
    'role',
    'authProvider',
    'isVerified',
    'locale',
    'avatarUrls',
    'createdAt',
    'updatedAt',
    'lastLoginAt',
    'deletedAt',
  ],
} as const;

const usersListResponseSchema = {
  $id: 'usersListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'usersListItemSchema#' } },
    limit: { type: 'number' },
    nextCursor: {
      anyOf: [{ type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' }, { type: 'null' }],
      description: 'The cursor of the next page, null on the last one.',
    },
    total: { type: 'number', description: 'How many accounts the filters find, on all pages.' },
  },
  required: ['items', 'limit', 'nextCursor', 'total'],
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
      description: `Avatar image: a jpeg, png or webp file by its content, up to ${MAX_UPLOAD_SIZE_BYTES / 1_000_000} MB. One file only.`,
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
  usersListQuerySchema,
  usersListItemSchema,
  usersListResponseSchema,
  usersGetByIdParamsSchema,
  usersGetByIdQuerySchema,
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

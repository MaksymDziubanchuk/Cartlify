export const usersGetByIdParamsSchema = {
  $id: 'usersGetByIdParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: { type: 'string' },
  },
  required: ['userId'],
} as const;

export const usersUserReviewResponseSchema = {
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

export const usersUserResponseSchema = {
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

export const usersGetMeResponseSchema = {
  $id: 'usersGetMeResponseSchema',
  allOf: [{ $ref: 'usersUserResponseSchema#' }],
} as const;

export const usersGetByIdResponseSchema = {
  $id: 'usersGetByIdResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    email: { type: 'string', format: 'email' },
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
  },
  required: ['id', 'email', 'createdAt', 'updatedAt'],
} as const;

export const usersUpdateMeBodySchema = {
  $id: 'usersUpdateMeBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    avatar: { type: 'object' },
    locale: { type: 'string' },
    phone: {
      type: 'string',
      minLength: 8,
      maxLength: 16,
      pattern: '^\\+[1-9]\\d{7,14}$',
    },
  },
} as const;

export const usersUpdateMeResponseSchema = {
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
  usersUpdateMeResponseSchema,
];

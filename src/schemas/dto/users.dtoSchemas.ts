export const usersGetByIdParamsSchema = {
  $id: 'usersGetByIdParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: { type: 'number' },
  },
  required: ['userId'],
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
  },
  required: ['id', 'email', 'role', 'isVerified', 'createdAt', 'updatedAt'],
} as const;

export const usersGetMeResponseSchema = {
  $id: 'usersGetMeResponseSchema',
  allOf: [{ $ref: 'usersUserResponseSchema#' }],
} as const;

export const usersGetByIdResponseSchema = {
  $id: 'usersGetByIdResponseSchema',
  allOf: [{ $ref: 'usersUserResponseSchema#' }],
} as const;

export const usersUpdateMeBodySchema = {
  $id: 'usersUpdateMeBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    avatarUrl: { type: 'string' },
    locale: { type: 'string' },
    phone: { type: 'string' },
  },
} as const;

export const usersUpdateMeResponseSchema = {
  $id: 'usersUpdateMeResponseSchema',
  allOf: [{ $ref: 'usersUserResponseSchema#' }],
} as const;

export const usersDtoSchemas = [
  usersGetByIdParamsSchema,
  usersUserResponseSchema,
  usersGetMeResponseSchema,
  usersGetByIdResponseSchema,
  usersUpdateMeBodySchema,
  usersUpdateMeResponseSchema,
];

export const authLoginBodySchema = {
  $id: 'authLoginBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 6 },
    rememberMe: { type: 'boolean' },
  },
  required: ['email', 'password'],
} as const;

export const authLoginResponseSchema = {
  $id: 'authLoginResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    accessToken: { type: 'string' },
    user: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number' },
        email: { type: 'string', format: 'email' },
        role: { type: 'string' },
        isVerified: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },

        name: { type: 'string' },
        avatarUrl: { type: 'string' },
        locale: { type: 'string' },
        phone: { type: 'string' },
      },
      required: ['id', 'email', 'role', 'isVerified', 'createdAt', 'updatedAt'],
    },
  },
  required: ['accessToken', 'user'],
} as const;

export const authGoogleCallbackQuerySchema = {
  $id: 'authGoogleCallbackQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string' },
    state: { type: 'string' },

    error: { type: 'string' },
    error_description: { type: 'string' },
  },
  required: ['code', 'state'],
} as const;

export const authRegisterBodySchema = {
  $id: 'authRegisterBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 6 },
    name: { type: 'string' },
  },
  required: ['email', 'password'],
} as const;

export const authRegisterResponseSchema = {
  $id: 'authRegisterResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    email: { type: 'string', format: 'email' },
    role: { type: 'string' },
    isVerified: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    name: { type: 'string' },
    avatarUrl: { type: 'string' },
    locale: { type: 'string' },
  },
  required: ['id', 'email', 'role', 'isVerified', 'createdAt', 'updatedAt'],
} as const;

export const authResendVerifyBodySchema = {
  $id: 'authResendVerifyBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
  },
  required: ['email'],
} as const;

export const authVerifyEmailQuerySchema = {
  $id: 'authVerifyEmailQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    token: { type: 'string', minLength: 10 },
  },
  required: ['token'],
} as const;

export const authPasswordForgotBodySchema = {
  $id: 'authPasswordForgotBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
  },
  required: ['email'],
} as const;

export const authPasswordResetQuerySchema = {
  $id: 'authPasswordResetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    token: { type: 'string' },
  },
  required: ['token'],
} as const;

export const authPasswordResetBodySchema = {
  $id: 'authPasswordResetBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    newPassword: { type: 'string', minLength: 6 },
  },
  required: ['newPassword'],
} as const;

export const authLogoutResponseSchema = {
  $id: 'authLogoutResponseSchema',
  type: 'null',
} as const;

export const authRefreshResponseSchema = {
  $id: 'authRefreshResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    email: { type: 'string', format: 'email' },
    role: { type: 'string' },
    isVerified: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    name: { type: 'string' },
    avatarUrl: { type: 'string' },
    locale: { type: 'string' },
  },
  required: ['id', 'email', 'role', 'isVerified', 'createdAt', 'updatedAt'],
} as const;

export const authDtoSchemas = [
  authLoginBodySchema,
  authLoginResponseSchema,
  authGoogleCallbackQuerySchema,
  authRegisterBodySchema,
  authRegisterResponseSchema,
  authResendVerifyBodySchema,
  authVerifyEmailQuerySchema,
  authPasswordForgotBodySchema,
  authPasswordResetQuerySchema,
  authPasswordResetBodySchema,
  authLogoutResponseSchema,
  authRefreshResponseSchema,
];

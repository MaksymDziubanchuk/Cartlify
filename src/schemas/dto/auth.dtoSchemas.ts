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
    userId: { type: 'number' },
  },
  required: ['userId'],
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
  authRegisterBodySchema,
  authRegisterResponseSchema,
  authResendVerifyBodySchema,
  authPasswordForgotBodySchema,
  authPasswordResetQuerySchema,
  authPasswordResetBodySchema,
  authLogoutResponseSchema,
  authRefreshResponseSchema,
];

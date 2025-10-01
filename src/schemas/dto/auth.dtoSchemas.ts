export const loginSchema = {
  $id: 'loginSchema',
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 6 },
  },
  required: ['email', 'password'],
  additionalProperties: false,
} as const;

export const registerSchema = {
  $id: 'registerSchema',
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 6 },
    name: { type: 'string' },
  },
  required: ['email', 'password'],
  additionalProperties: false,
} as const;

export const forgotPasswordSchema = {
  $id: 'forgotPasswordSchema',
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
  },
  required: ['email'],
  additionalProperties: false,
} as const;

export const resetPasswordSchema = {
  $id: 'resetPasswordSchema',
  type: 'object',
  properties: {
    token: { type: 'string' },
    newPassword: { type: 'string', minLength: 6 },
  },
  required: ['token', 'newPassword'],
  additionalProperties: false,
} as const;

export const authDtoSchemas = [
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
];

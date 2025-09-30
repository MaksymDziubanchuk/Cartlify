const loginSchema = {
  $id: 'loginSchema',
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 6 },
  },
  required: ['email', 'password'],
  additionalProperties: false,
} as const;

const registerSchema = {
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

const forgotPasswordSchema = {
  $id: 'forgotPasswordSchema',
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
  },
  required: ['email'],
  additionalProperties: false,
} as const;

const resetPasswordSchema = {
  $id: 'resetPasswordSchema',
  type: 'object',
  properties: {
    token: { type: 'string' },
    newPassword: { type: 'string', minLength: 6 },
  },
  required: ['token', 'newPassword'],
  additionalProperties: false,
} as const;

export const authSchemas = {
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
};

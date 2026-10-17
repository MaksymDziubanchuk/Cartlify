// a password that is stored: printable ascii only, one byte per character,
// so 64 characters always fit the 72 bytes bcrypt reads
const newPasswordSchema = {
  type: 'string',
  minLength: 6,
  maxLength: 64,
  pattern: '^[\\x20-\\x7E]+$',
  description:
    '6 to 64 characters: Latin letters, digits, spaces and ASCII symbols. ' +
    'Spaces at the start and the end are dropped.',
} as const;

const authLoginBodySchema = {
  $id: 'authLoginBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
    // wider than a new password, so passwords set before the limit still log in
    password: {
      type: 'string',
      minLength: 6,
      maxLength: 256,
      description: 'Up to 256 characters. Spaces at the start and the end are dropped.',
    },
    rememberMe: { type: 'boolean' },
  },
  required: ['email', 'password'],
} as const;

const authLoginResponseSchema = {
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

const authGoogleCallbackQuerySchema = {
  $id: 'authGoogleCallbackQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string' },
    state: { type: 'string' },

    error: { type: 'string' },
    error_description: { type: 'string' },
  },
  // a provider sends either the code with the state, or an error when the login was refused
  anyOf: [{ required: ['code', 'state'] }, { required: ['error'] }],
} as const;

const authGithubCallbackQuerySchema = {
  $id: 'authGithubCallbackQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string' },
    state: { type: 'string' },

    error: { type: 'string' },
    error_description: { type: 'string' },
    error_uri: { type: 'string' },
  },
  // a provider sends either the code with the state, or an error when the login was refused
  anyOf: [{ required: ['code', 'state'] }, { required: ['error'] }],
} as const;

const authLinkedInCallbackQuerySchema = {
  $id: 'authLinkedInCallbackQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string' },
    state: { type: 'string' },

    error: { type: 'string' },
    error_description: { type: 'string' },
    error_uri: { type: 'string' },
  },
  // a provider sends either the code with the state, or an error when the login was refused
  anyOf: [{ required: ['code', 'state'] }, { required: ['error'] }],
} as const;

const authRegisterBodySchema = {
  $id: 'authRegisterBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
    password: newPasswordSchema,
    name: { type: 'string' },
  },
  required: ['email', 'password'],
} as const;

const authRegisterResponseSchema = {
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
  required: ['id', 'email', 'role', 'isVerified', 'createdAt', 'updatedAt'],
} as const;

const authResendVerifyBodySchema = {
  $id: 'authResendVerifyBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
  },
  required: ['email'],
} as const;

const authVerifyEmailQuerySchema = {
  $id: 'authVerifyEmailQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    token: { type: 'string', minLength: 10 },
  },
  required: ['token'],
} as const;

const authPasswordForgotBodySchema = {
  $id: 'authPasswordForgotBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
  },
  required: ['email'],
} as const;

const authPasswordResetQuerySchema = {
  $id: 'authPasswordResetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    token: { type: 'string' },
  },
  required: ['token'],
} as const;

const authPasswordResetBodySchema = {
  $id: 'authPasswordResetBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    newPassword: newPasswordSchema,
  },
  required: ['newPassword'],
} as const;

const authLogoutBodySchema = {
  $id: 'authLogoutBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    allDevices: { type: 'boolean' },
  },
} as const;

const authLogoutResponseSchema = {
  $id: 'authLogoutResponseSchema',
  type: 'null',
} as const;

// both tokens travel in cookies only, the body stays empty
const authRefreshResponseSchema = {
  $id: 'authRefreshResponseSchema',
  type: 'null',
} as const;

// the page keeps the token in memory and sends it in x-csrf-token, its secret stays in a cookie
const authCsrfTokenResponseSchema = {
  $id: 'authCsrfTokenResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    csrfToken: { type: 'string', minLength: 1 },
  },
  required: ['csrfToken'],
} as const;

export const authDtoSchemas = [
  authLoginBodySchema,
  authLoginResponseSchema,
  authGoogleCallbackQuerySchema,
  authGithubCallbackQuerySchema,
  authLinkedInCallbackQuerySchema,
  authRegisterBodySchema,
  authRegisterResponseSchema,
  authResendVerifyBodySchema,
  authVerifyEmailQuerySchema,
  authPasswordForgotBodySchema,
  authPasswordResetQuerySchema,
  authPasswordResetBodySchema,
  authLogoutResponseSchema,
  authLogoutBodySchema,
  authRefreshResponseSchema,
  authCsrfTokenResponseSchema,
];

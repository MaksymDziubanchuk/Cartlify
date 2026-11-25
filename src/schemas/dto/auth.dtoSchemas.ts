import { avatarIsDefaultField, avatarUrlsField } from '@schemas/avatarFields.js';
import { captchaTokenField } from '@schemas/captchaField.js';
import { canManageMoneyField } from '@schemas/moneyManagerField.js';
import { canManageNewslettersField } from '@schemas/newsletterManagerField.js';
import { legalDocumentIdsSchema } from '@schemas/dto/legal.dtoSchemas.js';
import { PROFILE_TEXT_MAX_LENGTH } from '@helpers/profileText.js';

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
    acceptedDocumentIds: {
      ...legalDocumentIdsSchema,
      description:
        'The versions of the terms and of the contract in force the customer accepts at this ' +
        'login: the ones the login asked for with LEGAL_ACCEPTANCE_REQUIRED.',
    },
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
    avatarUrls: avatarUrlsField,
    avatarIsDefault: avatarIsDefaultField,
    canManageNewsletters: canManageNewslettersField,
    canManageMoney: canManageMoneyField,
    locale: { type: 'string' },
    phone: { type: 'string' },
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
  ],
} as const;

// the query a provider of accounts sends the browser back with, the same for every provider
const authOAuthCallbackQuerySchema = {
  $id: 'authOAuthCallbackQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', description: 'The code the provider gives after the login.' },
    state: {
      type: 'string',
      description: 'The state the app sent; the provider returns it unchanged.',
    },

    error: { type: 'string', description: 'What the provider says when the login was refused.' },
    error_description: {
      type: 'string',
      description: 'The words of the provider about the error.',
    },
    error_uri: { type: 'string', description: 'A page of the provider about the error.' },
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
    name: {
      type: 'string',
      maxLength: PROFILE_TEXT_MAX_LENGTH,
      description: `Display name, up to ${PROFILE_TEXT_MAX_LENGTH} characters. Spaces around it are cut.`,
    },
    locale: {
      type: 'string',
      maxLength: PROFILE_TEXT_MAX_LENGTH,
      description:
        'A language the shop answers in (GET /api/shop-settings, enabledLocales), case and a ' +
        'region ignored: uk-UA and UK both read as uk. Never refused: the wrong shape or a ' +
        'language the shop does not answer in is only dropped, the account keeps no locale and ' +
        "the confirmation mail goes in the shop's own language.",
    },
    acceptedDocumentIds: {
      ...legalDocumentIdsSchema,
      description:
        'The versions of the terms and of the contract in force the person accepts, each kind ' +
        'in force once; none while root has published none.',
    },
    newsletter: {
      type: 'boolean',
      description:
        'The box "Subscribe to the newsletter" of the form, ticked. It is not stored and subscribes ' +
        'nobody: when true, the link of the confirmation mail carries `newsletter=1`, a hint for ' +
        'the page that confirms the email, which then shows the box already ticked. The choice ' +
        'that counts is the one the page sends with the token (POST /api/auth/verify). The mail ' +
        'sent again by POST /api/auth/verify/resend carries no hint.',
    },
    captchaToken: captchaTokenField,
  },
  required: ['email', 'password', 'captchaToken'],
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
    avatarUrls: avatarUrlsField,
    avatarIsDefault: avatarIsDefaultField,
    canManageNewsletters: canManageNewslettersField,
    canManageMoney: canManageMoneyField,
    locale: { type: 'string' },
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
  ],
} as const;

const authResendVerifyBodySchema = {
  $id: 'authResendVerifyBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
    captchaToken: captchaTokenField,
  },
  required: ['email', 'captchaToken'],
} as const;

const authVerifyEmailBodySchema = {
  $id: 'authVerifyEmailBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    token: {
      type: 'string',
      minLength: 10,
      description:
        'The token from the link in the mail: the page of the link reads it after the # of the address.',
    },
    newsletter: {
      type: 'boolean',
      description:
        'The choice of the person on the page that confirms the email: the box "Subscribe to the ' +
        'newsletter", ticked (true) or not (false). When true and the email is confirmed by this ' +
        'call, the account is subscribed to the newsletter (the language of the account if the ' +
        'shop answers in it, none otherwise). The answer does not tell whether the address was ' +
        'subscribed already. A link that does not confirm the email subscribes nobody. The ' +
        '`newsletter=1` hint after the # of the link of the mail is only a hint for the box; what ' +
        'counts is this field.',
    },
  },
  required: ['token'],
} as const;

const authPasswordForgotBodySchema = {
  $id: 'authPasswordForgotBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
    captchaToken: captchaTokenField,
  },
  required: ['email', 'captchaToken'],
} as const;

const authPasswordResetBodySchema = {
  $id: 'authPasswordResetBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    token: {
      type: 'string',
      minLength: 10,
      description:
        'The token from the link in the mail: the page of the link reads it after the # of the address.',
    },
    newPassword: newPasswordSchema,
  },
  required: ['token', 'newPassword'],
} as const;

const authLogoutBodySchema = {
  $id: 'authLogoutBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    allDevices: { type: 'boolean' },
  },
} as const;

const authPasswordChangeBodySchema = {
  $id: 'authPasswordChangeBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    currentPassword: { type: 'string', minLength: 1, maxLength: 128 },
    newPassword: newPasswordSchema,
  },
  required: ['currentPassword', 'newPassword'],
} as const;

const authSessionIdParamsSchema = {
  $id: 'authSessionIdParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', format: 'uuid', description: 'The id of the session to close.' },
  },
  required: ['sessionId'],
} as const;

const authSessionsResponseSchema = {
  $id: 'authSessionsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'The session, the same across its renewals.',
          },
          device: {
            type: ['string', 'null'],
            description: 'The user agent of the browser that opened the session.',
          },
          lastUsedAt: {
            type: 'string',
            format: 'date-time',
            description: 'When the session was renewed last, or opened.',
          },
          expiresAt: { type: 'string', format: 'date-time' },
          current: { type: 'boolean', description: 'The session of this browser.' },
        },
        required: ['id', 'device', 'lastUsedAt', 'expiresAt', 'current'],
      },
    },
  },
  required: ['items'],
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

// THE SECOND STEP OF THE LOGIN OF AN ADMIN OR ROOT

const codeField = {
  type: 'string',
  minLength: 6,
  maxLength: 12,
  description: 'The six digits the authenticator app shows now (spaces are taken off).',
} as const;

const recoveryCodeField = {
  type: 'string',
  minLength: 10,
  maxLength: 20,
  description: 'One of the recovery codes, XXXXX-XXXXX (case, spaces and the dash do not matter).',
} as const;

const trustDeviceField = {
  type: 'boolean',
  description:
    'An admin trusts this browser for 30 days: the code is not asked on it at a login. Root has no ' +
    'trusted browsers, the field is ignored for root.',
} as const;

const authTwoFactorRequiredResponseSchema = {
  $id: 'authTwoFactorRequiredResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    twoFactor: {
      type: 'string',
      enum: ['setup', 'code'],
      description:
        'setup: the account has no authenticator app yet (POST /api/auth/two-factor/setup); code: a ' +
        'code of the app or a recovery code is next (POST /api/auth/two-factor/verify).',
    },
    canTrustDevice: {
      type: 'boolean',
      description: 'An admin may trust the browser, root may not.',
    },
  },
  required: ['twoFactor', 'canTrustDevice'],
} as const;

const authTwoFactorSecretResponseSchema = {
  $id: 'authTwoFactorSecretResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    otpauthUrl: {
      type: 'string',
      description: 'The otpauth:// link the page shows as a QR code for the app to scan.',
    },
    secret: {
      type: 'string',
      description: 'The same secret in base32, to type into the app by hand.',
    },
  },
  required: ['otpauthUrl', 'secret'],
} as const;

const authTwoFactorConfirmBodySchema = {
  $id: 'authTwoFactorConfirmBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: { code: codeField, trustDevice: trustDeviceField },
  required: ['code'],
} as const;

const authTwoFactorVerifyBodySchema = {
  $id: 'authTwoFactorVerifyBodySchema',
  type: 'object',
  additionalProperties: false,
  description: 'A code of the app or a recovery code, one of the two.',
  properties: { code: codeField, recoveryCode: recoveryCodeField, trustDevice: trustDeviceField },
} as const;

const recoveryCodesField = {
  type: 'array',
  items: { type: 'string' },
  description:
    'The ten recovery codes, shown this once: the person keeps them apart from the phone.',
} as const;

const authTwoFactorSetupResponseSchema = {
  $id: 'authTwoFactorSetupResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    ...authLoginResponseSchema.properties,
    recoveryCodes: recoveryCodesField,
  },
  required: [...authLoginResponseSchema.required, 'recoveryCodes'],
} as const;

const authTwoFactorCodeBodySchema = {
  $id: 'authTwoFactorCodeBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: { code: codeField },
  required: ['code'],
} as const;

const authTwoFactorProofBodySchema = {
  $id: 'authTwoFactorProofBodySchema',
  type: 'object',
  additionalProperties: false,
  description:
    'A code of the old app or a recovery code; none in the 10 minutes after a login with a recovery code.',
  properties: { code: codeField, recoveryCode: recoveryCodeField },
} as const;

const authTwoFactorRecoveryCodesResponseSchema = {
  $id: 'authTwoFactorRecoveryCodesResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: { recoveryCodes: recoveryCodesField },
  required: ['recoveryCodes'],
} as const;

const authTwoFactorStatusResponseSchema = {
  $id: 'authTwoFactorStatusResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    enabledAt: {
      type: 'string',
      format: 'date-time',
      description: 'When the account set the second step up first.',
    },
    recoveryCodesLeft: {
      type: 'integer',
      description: 'The recovery codes not used yet, of ten.',
    },
    devices: {
      type: 'array',
      description: 'The browsers the admin trusts, the expired ones left out; root has none.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          label: {
            type: 'string',
            description: 'The browser and the system, such as Chrome, Windows.',
          },
          createdAt: { type: 'string', format: 'date-time' },
          lastUsedAt: {
            type: 'string',
            format: 'date-time',
            description: 'The last login it let in without a code.',
          },
          expiresAt: { type: 'string', format: 'date-time' },
          current: { type: 'boolean', description: 'The browser of this request.' },
        },
        required: ['id', 'label', 'createdAt', 'lastUsedAt', 'expiresAt', 'current'],
      },
    },
  },
  required: ['enabledAt', 'recoveryCodesLeft', 'devices'],
} as const;

const authTrustedDeviceParamsSchema = {
  $id: 'authTrustedDeviceParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    deviceId: { type: 'string', format: 'uuid', description: 'The id of the trusted browser.' },
  },
  required: ['deviceId'],
} as const;

export const authDtoSchemas = [
  authLoginBodySchema,
  authLoginResponseSchema,
  authOAuthCallbackQuerySchema,
  authRegisterBodySchema,
  authRegisterResponseSchema,
  authResendVerifyBodySchema,
  authVerifyEmailBodySchema,
  authPasswordForgotBodySchema,
  authPasswordResetBodySchema,
  authLogoutResponseSchema,
  authLogoutBodySchema,
  authPasswordChangeBodySchema,
  authSessionIdParamsSchema,
  authSessionsResponseSchema,
  authRefreshResponseSchema,
  authCsrfTokenResponseSchema,
  authTwoFactorRequiredResponseSchema,
  authTwoFactorSecretResponseSchema,
  authTwoFactorConfirmBodySchema,
  authTwoFactorVerifyBodySchema,
  authTwoFactorSetupResponseSchema,
  authTwoFactorCodeBodySchema,
  authTwoFactorProofBodySchema,
  authTwoFactorRecoveryCodesResponseSchema,
  authTwoFactorStatusResponseSchema,
  authTrustedDeviceParamsSchema,
];

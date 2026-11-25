import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

// The second step of the login of an admin or root (docs/two-factor.md). After the password or a
// provider, the login answers 202 with the ticket in an httpOnly cookie, and these routes finish it;
// the signed-in routes keep the app, the recovery codes and the trusted browsers.

const secretResponseExample = {
  otpauthUrl:
    'otpauth://totp/Cartlify:admin%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cartlify&algorithm=SHA1&digits=6&period=30',
  secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
};

const recoveryCodesExample = [
  'ABCDE-FGHJK',
  'MNPQR-STUVW',
  'XYZ23-45678',
  '9ABCD-EFGHJ',
  'KMNPQ-RSTUV',
  'WXYZ2-34567',
  '89ABC-DEFGH',
  'JKMNP-QRSTU',
  'VWXYZ-23456',
  '789AB-CDEFG',
];

const loginExample = {
  id: 2,
  email: 'admin@example.com',
  role: 'ADMIN',
  isVerified: true,
  createdAt: '2026-11-25T09:00:00.000Z',
  updatedAt: '2026-11-25T09:00:00.000Z',
  name: 'Admin',
  avatarUrls: {
    url32: 'https://example.com/avatars/admin-32.webp',
    url64: 'https://example.com/avatars/admin-64.webp',
    url128: 'https://example.com/avatars/admin-128.webp',
    url256: 'https://example.com/avatars/admin-256.webp',
  },
  avatarIsDefault: false,
  canManageNewsletters: false,
  canManageMoney: false,
};

const TICKET_TEXT =
  '`TWO_FACTOR_TICKET_INVALID`: no ticket cookie, or it expired (10 minutes), or it is of another ' +
  'stage, or root reset the second step meanwhile: the login starts again.';

const PAUSE_TEXT =
  '`TWO_FACTOR_PAUSED`: 5 wrong codes in a row paused the second step of the account for 15 minutes; ' +
  'the wait is in `retry-after` and `details.retryAfterSeconds`.';

const LIMIT_TEXT =
  '`RATE_LIMITED` with `details.limit: twoFactor`: too many requests of the second step from one ' +
  'address in 10 minutes (the budget of the logins); the wait is in `retry-after`.';

const NOT_STAFF_TEXT = '`INSUFFICIENT_ROLE`: the account is not an admin or root.';

const NO_ROW_TEXT =
  '`TWO_FACTOR_NOT_FOUND`: the account has no second step (a session from before it, or root reset it).';

const twoFactorSetupStartSchema = {
  operationId: 'startTwoFactorSetup',
  summary: 'Start the setup of the authenticator app',
  description:
    'The login of an admin or root without an app answered 202 `twoFactor: setup`. This gives a new ' +
    'secret: the page shows `otpauthUrl` as a QR code (or `secret` to type in), and the ticket cookie ' +
    'keeps the secret, encrypted, until the first code confirms it. A new call gives a new secret.',

  response: {
    200: {
      description: 'The secret of the new app.',
      $ref: 'authTwoFactorSecretResponseSchema#',
      examples: [secretResponseExample],
    },
    401: { description: TICKET_TEXT, $ref: 'errorResponseSchema#' },
    409: {
      description:
        '`TWO_FACTOR_ALREADY_ENABLED`: the account set the app up already; log in again.',
      $ref: 'errorResponseSchema#',
    },
    429: { description: LIMIT_TEXT, $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const twoFactorSetupConfirmSchema = {
  operationId: 'confirmTwoFactorSetup',
  summary: 'Confirm the authenticator app and log in',
  description:
    'The first code of the new app confirms its secret: the second step of the account is on, the ' +
    'session opens (the cookies as after a login) and the answer has ten recovery codes, shown this ' +
    'once. An admin may trust the browser (`trustDevice`).',

  body: { $ref: 'authTwoFactorConfirmBodySchema#', examples: [{ code: '123456' }] },

  response: {
    200: {
      description: 'The session opened; the profile and the recovery codes.',
      $ref: 'authTwoFactorSetupResponseSchema#',
      examples: [{ ...loginExample, recoveryCodes: recoveryCodesExample }],
    },
    401: {
      description:
        '`TWO_FACTOR_CODE_INVALID`: the code is not one of the new app now. ' + TICKET_TEXT,
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`TWO_FACTOR_ALREADY_ENABLED`: the account set the app up already; log in again.',
      $ref: 'errorResponseSchema#',
    },
    429: { description: LIMIT_TEXT, $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const twoFactorVerifySchema = {
  operationId: 'verifyTwoFactor',
  summary: 'Finish a login with the code of the app',
  description:
    'The login of an admin or root answered 202 `twoFactor: code`. A code of the app or one of the ' +
    'recovery codes finishes it: the session opens (the cookies as after a login). A code works once. ' +
    'A login with a recovery code sends the owner a mail with the codes left, and lets the move to a ' +
    'new app go without another proof for 10 minutes. An admin may trust the browser (`trustDevice`).',

  body: {
    $ref: 'authTwoFactorVerifyBodySchema#',
    examples: [{ code: '123456', trustDevice: true }],
  },

  response: {
    200: {
      description: 'The session opened.',
      $ref: 'authLoginResponseSchema#',
      examples: [loginExample],
    },
    400: {
      description: '`TWO_FACTOR_PROOF_REQUIRED`: neither a code nor a recovery code, or both.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description:
        '`TWO_FACTOR_CODE_INVALID`: the code or the recovery code is wrong (it counts toward the pause). ' +
        '`TWO_FACTOR_RECOVERY_CODE_USED`: the recovery code was used before, take another (it does not ' +
        'count). ' +
        TICKET_TEXT,
      $ref: 'errorResponseSchema#',
    },
    429: { description: `${PAUSE_TEXT} ${LIMIT_TEXT}`, $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const getTwoFactorSchema = {
  operationId: 'getTwoFactor',
  summary: 'The second step of the signed-in admin or root',
  description:
    'When the second step was set up, how many recovery codes are left, and the browsers the admin ' +
    'trusts, which one is this browser.',
  security: openApiSecurity.authCookies,

  response: {
    200: {
      description: 'The second step of the account.',
      $ref: 'authTwoFactorStatusResponseSchema#',
      examples: [
        {
          enabledAt: '2026-11-25T09:00:00.000Z',
          recoveryCodesLeft: 9,
          devices: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              label: 'Chrome, Windows',
              createdAt: '2026-11-25T09:00:00.000Z',
              lastUsedAt: '2026-11-26T09:00:00.000Z',
              expiresAt: '2026-12-25T09:00:00.000Z',
              current: true,
            },
          ],
        },
      ],
    },
    404: { description: NO_ROW_TEXT, $ref: 'errorResponseSchema#' },
    429: { description: LIMIT_TEXT, $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const deleteTrustedDeviceSchema = {
  operationId: 'forgetTrustedDevice',
  summary: 'Stop trusting a browser',
  description:
    'The admin no longer trusts the browser: the code is asked on it at the next login. Forgetting ' +
    'this browser clears its cookie.',
  security: openApiSecurity.authCookies,

  params: { $ref: 'authTrustedDeviceParamsSchema#' },

  response: {
    204: { description: 'The browser is no longer trusted.', $ref: 'authLogoutResponseSchema#' },
    404: {
      description:
        '`TRUSTED_DEVICE_NOT_FOUND`: the account trusts no browser of the id. ' + NO_ROW_TEXT,
      $ref: 'errorResponseSchema#',
    },
    429: { description: LIMIT_TEXT, $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const renewRecoveryCodesSchema = {
  operationId: 'renewRecoveryCodes',
  summary: 'A new set of recovery codes',
  description:
    'A code of the app gives ten new recovery codes, shown this once; the old ones stop working.',
  security: openApiSecurity.authCookies,

  body: { $ref: 'authTwoFactorCodeBodySchema#', examples: [{ code: '123456' }] },

  response: {
    200: {
      description: 'The new recovery codes.',
      $ref: 'authTwoFactorRecoveryCodesResponseSchema#',
      examples: [{ recoveryCodes: recoveryCodesExample }],
    },
    401: {
      description: '`TWO_FACTOR_CODE_INVALID`: the code is wrong (it counts toward the pause).',
      $ref: 'errorResponseSchema#',
    },
    404: { description: NO_ROW_TEXT, $ref: 'errorResponseSchema#' },
    429: { description: `${PAUSE_TEXT} ${LIMIT_TEXT}`, $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const twoFactorReplaceStartSchema = {
  operationId: 'startTwoFactorReplace',
  summary: 'Move to a new authenticator app',
  description:
    'A code of the old app or a recovery code proves the person (no proof for 10 minutes in the session ' +
    'a recovery code opened, another session of the account gives one). The answer has the secret of ' +
    'the new app; the ticket cookie keeps it until a code of the new app confirms it, and the old app ' +
    'works until then.',
  security: openApiSecurity.authCookies,

  body: { $ref: 'authTwoFactorProofBodySchema#', examples: [{ code: '123456' }] },

  response: {
    200: {
      description: 'The secret of the new app.',
      $ref: 'authTwoFactorSecretResponseSchema#',
      examples: [secretResponseExample],
    },
    400: {
      description:
        '`TWO_FACTOR_PROOF_REQUIRED`: neither a code nor a recovery code (and no login with a ' +
        'recovery code in the last 10 minutes), or both.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description:
        '`TWO_FACTOR_CODE_INVALID`: the code or the recovery code is wrong (it counts toward the pause). ' +
        '`TWO_FACTOR_RECOVERY_CODE_USED`: the recovery code was used before.',
      $ref: 'errorResponseSchema#',
    },
    403: { description: NOT_STAFF_TEXT, $ref: 'errorResponseSchema#' },
    404: { description: NO_ROW_TEXT, $ref: 'errorResponseSchema#' },
    429: { description: `${PAUSE_TEXT} ${LIMIT_TEXT}`, $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const twoFactorReplaceConfirmSchema = {
  operationId: 'confirmTwoFactorReplace',
  summary: 'Confirm the new authenticator app',
  description:
    'The first code of the new app makes it the one: the old app stops working, every trusted browser ' +
    'is forgotten (this one loses its cookie), the session goes on.',
  security: openApiSecurity.authCookies,

  body: { $ref: 'authTwoFactorCodeBodySchema#', examples: [{ code: '123456' }] },

  response: {
    204: { description: 'The new app is the one.', $ref: 'authLogoutResponseSchema#' },
    401: {
      description:
        '`TWO_FACTOR_CODE_INVALID`: the code is not one of the new app now. ' +
        '`TWO_FACTOR_TICKET_INVALID`: no ticket of a move of this account, or it expired (10 minutes).',
      $ref: 'errorResponseSchema#',
    },
    404: { description: NO_ROW_TEXT, $ref: 'errorResponseSchema#' },
    429: { description: LIMIT_TEXT, $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const twoFactorSchema = withOpenApiTag(
  {
    twoFactorSetupStartSchema,
    twoFactorSetupConfirmSchema,
    twoFactorVerifySchema,
    getTwoFactorSchema,
    deleteTrustedDeviceSchema,
    renewRecoveryCodesSchema,
    twoFactorReplaceStartSchema,
    twoFactorReplaceConfirmSchema,
  },
  'auth',
);

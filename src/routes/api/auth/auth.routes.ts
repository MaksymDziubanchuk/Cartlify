import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireCaptcha from '@middlewares/requireCaptcha.js';
import requireRole from '@middlewares/requireRole.js';
import { identityProviders } from '@providers/identity/index.js';
import { requestLimits } from '../../../plugins/requestLimits.js';
import { authSchema } from './auth.schemas.js';
import { authController } from './auth.controllers.js';
import { twoFactorSchema } from './twoFactor.schemas.js';
import { twoFactorController } from './twoFactor.controllers.js';

export default async function authRouter(app: FastifyInstance) {
  app.post(
    '/register',
    {
      // the limit of the address before the captcha, the limit of the email after it: a request the
      // guards and the limit of the address refuse costs no call to the captcha, and a captcha that
      // fails takes no place of the email. The place is given back when the registration does not end
      // in 201, so only the registrations that succeed count
      preHandler: [
        authGuard,
        requireRole(['GUEST']),
        ...requestLimits.register,
        requireCaptcha,
        ...requestLimits.registerToEmail,
      ],
      onSend: requestLimits.registerToEmailDone,
      schema: authSchema.setRegisterSchema,
    },
    authController.postRegister,
  );

  // the login with an account at each provider (src/providers/identity): the start sends the browser
  // of a guest to the provider, the callback is where the provider sends it back
  for (const provider of identityProviders) {
    app.get(
      `/oauth/${provider.name}`,
      { preHandler: [authGuard], schema: authSchema.oauthStartSchemaOf(provider) },
      authController.oauthStartOf(provider),
    );

    app.get(
      `/${provider.name}/callback`,
      { preHandler: [authGuard], schema: authSchema.oauthCallbackSchemaOf(provider) },
      authController.oauthCallbackOf(provider),
    );
  }

  app.post(
    '/login',
    {
      preHandler: [authGuard, requireRole(['GUEST']), ...requestLimits.login],
      schema: authSchema.setLoginSchema,
    },
    authController.postLogin,
  );
  app.post(
    '/verify/resend',
    {
      // the limit of the address before the captcha, the limit of the email after it: a captcha that
      // fails spends no count of the email
      preHandler: [
        authGuard,
        requireRole(['GUEST']),
        ...requestLimits.mail,
        requireCaptcha,
        ...requestLimits.mailToEmail,
      ],
      schema: authSchema.setVerifyResendSchema,
    },
    authController.postVerifyResend,
  );
  // a post and not a get: opening a link (a mail scanner, a preview) must verify nobody. The page of
  // the link reads the token after the # and posts it here
  app.post('/verify', { schema: authSchema.authVerifyEmailSchema }, authController.postVerifyEmail);
  // open to everyone: a guest changes the cart too, so the token is needed before any login
  app.get('/csrf', { schema: authSchema.setCsrfTokenSchema }, authController.getCsrfToken);
  app.post(
    '/password/forgot',
    {
      preHandler: [authGuard, ...requestLimits.mail, requireCaptcha, ...requestLimits.mailToEmail],
      schema: authSchema.setPasswordForgotSchema,
    },
    authController.postPasswordForgot,
  );
  app.post(
    '/password/reset',
    {
      preHandler: [authGuard],
      schema: authSchema.setPasswordResetSchema,
    },
    authController.postPasswordReset,
  );
  app.post(
    '/logout',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: authSchema.setLogoutSchema,
    },
    authController.postLogout,
  );
  app.get(
    '/sessions',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: authSchema.getSessionsSchema,
    },
    authController.getSessions,
  );
  app.delete(
    '/sessions/:sessionId',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: authSchema.deleteSessionSchema,
    },
    authController.deleteSession,
  );
  app.post(
    '/password/change',
    {
      preHandler: [
        authGuard,
        requireRole(['USER', 'ADMIN', 'ROOT']),
        ...requestLimits.passwordChange,
      ],
      schema: authSchema.setPasswordChangeSchema,
    },
    authController.postPasswordChange,
  );
  app.post(
    '/refresh',
    {
      // no authGuard: the refresh token is the credential, the controller checks it once
      schema: authSchema.setRefreshSchema,
    },
    authController.postRefresh,
  );

  // the second step of the login of an admin or root: the ticket of the first step is in its cookie,
  // so these run for a guest of the browser that logged in
  const guestOnly = { preHandler: [authGuard, requireRole(['GUEST']), ...requestLimits.twoFactor] };
  app.post(
    '/two-factor/setup',
    { ...guestOnly, schema: twoFactorSchema.twoFactorSetupStartSchema },
    twoFactorController.postSetupStart,
  );
  app.post(
    '/two-factor/setup/confirm',
    { ...guestOnly, schema: twoFactorSchema.twoFactorSetupConfirmSchema },
    twoFactorController.postSetupConfirm,
  );
  app.post(
    '/two-factor/verify',
    { ...guestOnly, schema: twoFactorSchema.twoFactorVerifySchema },
    twoFactorController.postVerify,
  );

  // the second step of the signed-in admin or root
  const staffOnly = {
    preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), ...requestLimits.twoFactor],
  };
  app.get(
    '/two-factor',
    { ...staffOnly, schema: twoFactorSchema.getTwoFactorSchema },
    twoFactorController.getStatus,
  );
  app.delete(
    '/two-factor/devices/:deviceId',
    { ...staffOnly, schema: twoFactorSchema.deleteTrustedDeviceSchema },
    twoFactorController.deleteDevice,
  );
  app.post(
    '/two-factor/recovery-codes',
    { ...staffOnly, schema: twoFactorSchema.renewRecoveryCodesSchema },
    twoFactorController.postRecoveryCodes,
  );
  app.post(
    '/two-factor/replace',
    { ...staffOnly, schema: twoFactorSchema.twoFactorReplaceStartSchema },
    twoFactorController.postReplaceStart,
  );
  app.post(
    '/two-factor/replace/confirm',
    { ...staffOnly, schema: twoFactorSchema.twoFactorReplaceConfirmSchema },
    twoFactorController.postReplaceConfirm,
  );
}

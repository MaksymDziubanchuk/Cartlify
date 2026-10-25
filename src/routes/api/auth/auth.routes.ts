import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { requestLimits } from '../../../plugins/requestLimits.js';
import { authSchema } from './auth.schemas.js';
import { authController } from './auth.controllers.js';

export default async function authRouter(app: FastifyInstance) {
  app.post(
    '/register',
    {
      preHandler: [authGuard, requireRole(['GUEST']), ...requestLimits.register],
      schema: authSchema.setRegisterSchema,
    },
    authController.postRegister,
  );

  app.get(
    '/oauth/google',
    {
      preHandler: [authGuard],
      schema: authSchema.setGoogleStartSchema,
    },
    authController.getGoogleStart,
  );

  app.get(
    '/google/callback',
    {
      preHandler: [authGuard],
      schema: authSchema.setGoogleCallbackSchema,
    },
    authController.getGoogleCallback,
  );

  app.get(
    '/oauth/github',
    {
      preHandler: [authGuard],
      schema: authSchema.setGithubStartSchema,
    },
    authController.getGithubStart,
  );

  app.get(
    '/github/callback',
    {
      preHandler: [authGuard],
      schema: authSchema.setGithubCallbackSchema,
    },
    authController.getGithubCallback,
  );
  app.get(
    '/oauth/linkedin',
    {
      preHandler: [authGuard],
      schema: authSchema.setLinkedInStartSchema,
    },
    authController.getLinkedInStart,
  );
  app.get(
    '/linkedin/callback',
    {
      preHandler: [authGuard],
      schema: authSchema.setLinkedInCallbackSchema,
    },
    authController.getLinkedInCallback,
  );
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
      preHandler: [authGuard, requireRole(['GUEST']), ...requestLimits.mail],
      schema: authSchema.setVerifyResendSchema,
    },
    authController.postVerifyResend,
  );
  app.get('/verify', { schema: authSchema.authVerifyEmailSchema }, authController.getVerifyEmail);
  // open to everyone: a guest changes the cart too, so the token is needed before any login
  app.get('/csrf', { schema: authSchema.setCsrfTokenSchema }, authController.getCsrfToken);
  app.post(
    '/password/forgot',
    {
      preHandler: [authGuard, ...requestLimits.mail],
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
}

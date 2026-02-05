import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { authSchema } from './auth.schemas.js';
import { authController } from './auth.controllers.js';

export default async function authRouter(app: FastifyInstance, opt: unknown) {
  app.post(
    '/register',
    {
      preHandler: [authGuard, requireRole(['GUEST'])],
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
      preHandler: [authGuard, requireRole(['GUEST'])],
      schema: authSchema.setLoginSchema,
    },
    authController.postLogin,
  );
  app.post(
    '/verify/resend',
    {
      preHandler: [authGuard, requireRole(['GUEST'])],
      schema: authSchema.setVerifyResendSchema,
    },
    authController.postVerifyResend,
  );
  app.get('/verify', { schema: authSchema.authVerifyEmailSchema }, authController.getVerifyEmail);
  app.post(
    '/password/forgot',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: authSchema.setPasswordForgotSchema,
    },
    authController.postPasswordForgot,
  );
  app.post(
    '/password/reset',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
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
  app.post(
    '/refresh',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: authSchema.setRefreshSchema,
    },
    authController.postRefresh,
  );
}

import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { authSchema } from './auth.schemas.js';
import { authController } from './auth.controllers.js';

export default async function authRouter(app: FastifyInstance, opt: unknown) {
  app.post(
    '/login',
    {
      preHandler: [authGuard, requireRole(['GUEST'])],
      schema: authSchema.setLoginSchema,
    },
    authController.postLogin,
  );
  app.post(
    '/register',
    {
      preHandler: [authGuard, requireRole(['GUEST'])],
      schema: authSchema.setRegisterSchema,
    },
    authController.postRegister,
  );
  app.post(
    '/verify/resend',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: authSchema.setVerifyResendSchema,
    },
    authController.postVerifyResend,
  );
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

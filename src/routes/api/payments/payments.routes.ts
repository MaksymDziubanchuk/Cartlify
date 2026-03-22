import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { paymentsController } from './payments.controllers.js';
import { paymentsSchema } from './payments.schemas.js';

export default async function paymentsRouter(app: FastifyInstance, opt: unknown) {
  app.post(
    '/checkout/sessions',
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: paymentsSchema.postCheckoutSessionSchema,
    },
    paymentsController.postCheckoutSession,
  );

  //   app.get(
  //     '/checkout/sessions/:sessionId',
  //     {
  //       preHandler: [authGuard, requireRole(['USER'])],
  //       schema: paymentsSchema.getCheckoutSessionByIdSchema,
  //     },
  //     paymentsController.getCheckoutSessionById,
  //   );

  //   app.post(
  //     '/webhook',
  //     {
  //       config: { rawBody: true },
  //       schema: paymentsSchema.postStripeWebhookSchema,
  //     },
  //     paymentsController.postStripeWebhook,
  //   );
}

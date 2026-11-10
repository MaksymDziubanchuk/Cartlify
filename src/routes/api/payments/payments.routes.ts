import { FastifyInstance } from 'fastify';

import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';

import { requestLimits } from '../../../plugins/requestLimits.js';

import { paymentsController } from './payments.controllers.js';
import { paymentsSchema } from './payments.schemas.js';
import { stripeRouter } from './providers/stripe/index.js';

export default async function paymentsRouter(app: FastifyInstance) {
  // the payment page of an order, with the provider the buyer picked
  app.post(
    '/checkout/sessions',
    {
      preHandler: [authGuard, requireRole(['USER']), ...requestLimits.checkout],
      schema: paymentsSchema.postCheckoutSessionSchema,
    },
    paymentsController.postCheckoutSession,
  );

  // the refunds that wait for the shop (admin, root), and root recording one that failed as sent
  // another way
  app.get(
    '/refunds',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: paymentsSchema.getRefundsSchema,
    },
    paymentsController.getRefunds,
  );
  app.post(
    '/refunds/:refundId/outside',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: paymentsSchema.postRefundOutsideSchema,
    },
    paymentsController.postRefundOutside,
  );

  // each provider keeps its own routes (its events, its return page) under its name
  app.register(stripeRouter, { prefix: '/stripe' });
}

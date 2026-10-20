import { FastifyInstance } from 'fastify';

import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';

import { paymentsController } from './payments.controllers.js';
import { paymentsSchema } from './payments.schemas.js';
import { stripeRouter } from './providers/stripe/index.js';

export default async function paymentsRouter(app: FastifyInstance) {
  // the payment page of an order, with the provider the buyer picked
  app.post(
    '/checkout/sessions',
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: paymentsSchema.postCheckoutSessionSchema,
    },
    paymentsController.postCheckoutSession,
  );

  // each provider keeps its own routes (its events, its return page) under its name
  app.register(stripeRouter, { prefix: '/stripe' });
}

import { FastifyInstance } from 'fastify';

import authGuard from '@middlewares/auth.js';
import requireMoneyManager from '@middlewares/requireMoneyManager.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';

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

  // the refunds of the money journal (admin, root), and root recording one that failed as sent
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
      preHandler: [
        authGuard,
        requireRole(['ADMIN', 'ROOT']),
        requireMoneyManager,
        validateId('refundId'),
      ],
      schema: paymentsSchema.postRefundOutsideSchema,
    },
    paymentsController.postRefundOutside,
  );

  // root gives the buyer of an order a compensation through its payment
  app.post(
    '/compensations',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), requireMoneyManager],
      schema: paymentsSchema.postCompensationSchema,
    },
    paymentsController.postCompensation,
  );

  // root says what money given back by hand in the dashboard of the provider, or taken by a bank
  // for a dispute the shop lost, was for: the items and the delivery of the order, the rest a
  // compensation or a loss (the rows of open statements it pays all of are paid at once)
  app.post(
    '/money-lines/:moneyLogId/decision',
    {
      preHandler: [
        authGuard,
        requireRole(['ADMIN', 'ROOT']),
        requireMoneyManager,
        validateId('moneyLogId'),
      ],
      schema: paymentsSchema.postMoneyDecisionSchema,
    },
    paymentsController.postMoneyDecision,
  );

  // the disputes of the payments at the bank (admin, root), and the card of one
  app.get(
    '/disputes',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: paymentsSchema.getDisputesSchema,
    },
    paymentsController.getDisputes,
  );
  app.get(
    '/disputes/:disputeId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('disputeId')],
      schema: paymentsSchema.getDisputeSchema,
    },
    paymentsController.getDispute,
  );

  // each provider keeps its own routes (its events, its return page) under its name
  app.register(stripeRouter, { prefix: '/stripe' });
}

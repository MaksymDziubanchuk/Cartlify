import { FastifyInstance, FastifyRequest } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { paymentsController } from './payments.controllers.js';
import { paymentsSchema } from './payments.schemas.js';

import { BadRequestError } from '@utils/errors.js';

function parsePaymentsJsonBody(req: FastifyRequest, body: string | Buffer<ArrayBufferLike>) {
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  req.rawBody = rawBody;

  if (body.length === 0) return {};

  try {
    return JSON.parse(body.toString('utf8'));
  } catch (err) {
    throw new BadRequestError('REQUEST_BODY_INVALID_JSON', { cause: err });
  }
}

export default async function paymentsRouter(app: FastifyInstance, opt: unknown) {
  app.removeContentTypeParser('application/json');

  app.addContentTypeParser(
    /^application\/json(?:\s*;.*)?$/i,
    { parseAs: 'buffer' },
    (req, body, done) => {
      try {
        done(null, parsePaymentsJsonBody(req, body));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.post(
    '/checkout/sessions',
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: paymentsSchema.postCheckoutSessionSchema,
    },
    paymentsController.postCheckoutSession,
  );

  app.get(
    '/checkout/sessions/:sessionId',
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: paymentsSchema.getCheckoutSessionByIdSchema,
    },
    paymentsController.getCheckoutSessionById,
  );

  app.post(
    '/webhook',
    {
      config: { rawBody: true },
      schema: paymentsSchema.postStripeWebhookSchema,
    },
    paymentsController.postStripeWebhook,
  );
}

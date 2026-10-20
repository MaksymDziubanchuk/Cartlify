import { FastifyInstance, FastifyRequest } from 'fastify';

import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { BadRequestError } from '@utils/errors.js';

import { stripeController } from './stripe.controllers.js';
import { stripeSchema } from './stripe.schemas.js';

// stripe signs the exact bytes it sent, so the json body keeps them next to the parsed one
function parseStripeJsonBody(req: FastifyRequest, body: string | Buffer<ArrayBufferLike>) {
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  req.rawBody = rawBody;

  if (body.length === 0) return {};

  try {
    return JSON.parse(body.toString('utf8'));
  } catch (err) {
    throw new BadRequestError('REQUEST_BODY_INVALID_JSON', { cause: err });
  }
}

// the routes of stripe itself, under /api/payments/stripe: the page the buyer comes back to and
// the events stripe delivers
export default async function stripeRouter(app: FastifyInstance) {
  app.removeContentTypeParser('application/json');

  app.addContentTypeParser(
    /^application\/json(?:\s*;.*)?$/i,
    { parseAs: 'buffer' },
    (req, body, done) => {
      try {
        done(null, parseStripeJsonBody(req, body));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.get(
    '/checkout/sessions/:sessionId',
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: stripeSchema.getCheckoutSessionByIdSchema,
    },
    stripeController.getCheckoutSessionById,
  );

  // the path is STRIPE_WEBHOOK_PATH of the stripe provider: outside the request rate limit
  app.post(
    '/webhook',
    {
      // stripe calls it server to server and signs the body, there is no browser and no csrf token
      config: { rawBody: true, csrf: false },
      schema: stripeSchema.postStripeWebhookSchema,
    },
    stripeController.postWebhook,
  );
}

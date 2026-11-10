import type { FastifyInstance } from 'fastify';

import { SENDGRID_WEBHOOK_BODY_LIMIT_BYTES } from '@config/limits.js';

import { newslettersController } from './newsletters.controllers.js';
import { newslettersWebhookSchema } from './newsletters.webhook.schemas.js';

// The route SendGrid posts the events of the newsletters to, under /api/newsletters; its path is
// SENDGRID_WEBHOOK_PATH (newsletters.paths.ts), outside the request rate limit. It is a plugin of its
// own so that the parser of its body is its own: the signature is made over the exact bytes SendGrid
// sent, so the body stays a buffer, and is read as JSON only after the signature held (an unsigned
// request is never parsed). The other routes of the module keep the parser that reads JSON
export default async function sendGridWebhookRouter(app: FastifyInstance) {
  // JSON only: the parser of plain text that fastify has by default would hand the handler a body
  // without the bytes the signature covers
  app.removeAllContentTypeParsers();

  app.addContentTypeParser(
    /^application\/json(?:\s*;.*)?$/i,
    { parseAs: 'buffer' },
    (req, body, done) => {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
      req.rawBody = raw;
      done(null, raw);
    },
  );

  app.post(
    '/sendgrid/webhook',
    {
      // a batch of events is bigger than the json bodies of the other routes
      bodyLimit: SENDGRID_WEBHOOK_BODY_LIMIT_BYTES,
      // SendGrid calls it server to server and signs the body: no browser, no csrf token
      config: { rawBody: true, csrf: false },
      schema: newslettersWebhookSchema.postSendGridWebhookSchema,
    },
    newslettersController.postSendGridWebhook,
  );
}

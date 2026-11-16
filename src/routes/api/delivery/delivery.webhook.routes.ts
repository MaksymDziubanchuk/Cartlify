import type { FastifyInstance } from 'fastify';

import { deliveryProvider } from '@providers/delivery/index.js';

import { deliveryController } from './delivery.controllers.js';
import { deliverySchemas } from './delivery.schemas.js';

// The route the delivery provider posts the events of the parcels to, under /api/delivery; its path
// is DELIVERY_WEBHOOK_PATH (src/providers/delivery/index.ts), outside the request rate limit. The
// provider calls it server to server with the secret of the webhook in a header: no browser, no csrf
// token
export default async function deliveryWebhookRouter(app: FastifyInstance) {
  app.post(
    `/${deliveryProvider.name}/webhook`,
    {
      bodyLimit: deliveryProvider.webhook.bodyLimit,
      config: { csrf: false },
      schema: deliverySchemas.postDeliveryWebhookSchema,
    },
    deliveryController.postWebhook,
  );
}

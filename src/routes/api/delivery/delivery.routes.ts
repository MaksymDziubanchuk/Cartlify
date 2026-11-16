import { FastifyInstance } from 'fastify';

import { deliveryController } from './delivery.controllers.js';
import deliveryWebhookRouter from './delivery.webhook.routes.js';
import { deliverySchemas } from './delivery.schemas.js';

// how the shop gets an order to its buyer: the methods and the zones; and the route the delivery
// provider posts the events of the parcels to
export default async function deliveryRouter(app: FastifyInstance) {
  app.get(
    '/methods',
    { schema: deliverySchemas.getDeliveryMethodsSchema },
    deliveryController.getMethods,
  );

  await app.register(deliveryWebhookRouter);
}

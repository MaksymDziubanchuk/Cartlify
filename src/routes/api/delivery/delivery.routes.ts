import { FastifyInstance } from 'fastify';

import { deliveryController } from './delivery.controllers.js';
import { deliverySchemas } from './delivery.schemas.js';

// how the shop gets an order to its buyer: the methods, their prices and countries
export default async function deliveryRouter(app: FastifyInstance) {
  app.get(
    '/methods',
    { schema: deliverySchemas.getDeliveryMethodsSchema },
    deliveryController.getMethods,
  );
}

import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { ordersSchema } from './orders.schemas.js';
import { ordersController } from './orders.controllers.js';

export default async function ordersRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: ordersSchema.getOrdersSchema,
    },
    ordersController.getOrders,
  );
  app.get(
    '/:orderId',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT']), validateId('orderId')],
      schema: ordersSchema.getOrderByIdSchema,
    },
    ordersController.getOrderById,
  );
  app.post(
    '/',
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: ordersSchema.postOrderSchema,
    },
    ordersController.postOrder,
  );
  app.patch(
    '/:orderId/status',
    {
      preHandler: [authGuard, requireRole(['ADMIN']), validateId('orderId')],
      schema: ordersSchema.patchOrderStatusSchema,
    },
    ordersController.putOrderStatus,
  );
  app.patch(
    '/:orderId/confirm',
    {
      preHandler: [authGuard, requireRole(['ADMIN']), validateId('orderId')],
      schema: ordersSchema.patchOrderConfirmSchema,
    },
    ordersController.putOrderConfirmStatus,
  );
  app.delete(
    '/:orderId',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('orderId')],
      schema: ordersSchema.deleteOrderSchema,
    },
    ordersController.deleteOrder,
  );
}

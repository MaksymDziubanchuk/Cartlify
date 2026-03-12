import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { ordersSchema } from './orders.schemas.js';
import { ordersController } from './orders.controllers.js';

export default async function ordersRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/current',
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: ordersSchema.getCurrentOrderSchema,
    },
    ordersController.getCurrentOrder,
  );

  app.post(
    '/current/items',
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: ordersSchema.postCurrentItemsSchema,
    },
    ordersController.postCurrentItems,
  );

  app.patch(
    '/current/items/:itemId',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('itemId')],
      schema: ordersSchema.patchCurrentItemsSchema,
    },
    ordersController.patchCurrentItems,
  );

  app.delete(
    '/current/items/:itemId',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('itemId')],
      schema: ordersSchema.deleteCurrentItemsSchema,
    },
    ordersController.deleteCurrentItems,
  );

  app.post(
    '/current/confirm',
    { preHandler: [authGuard, requireRole(['USER'])] },
    async (req, reply) =>
      reply.code(200).send({ message: 'orders.current.confirm: not implemented' }),
  );

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

  app.patch(
    '/:orderId/status',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('orderId')],
      schema: ordersSchema.patchOrderStatusSchema,
    },
    ordersController.putOrderStatus,
  );
}

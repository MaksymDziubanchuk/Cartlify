import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { ordersSchema } from './orders.schemas.js';
import { ordersController } from './orders.controllers.js';

export default async function ordersRouter(app: FastifyInstance) {
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
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: ordersSchema.postCurrentConfirmSchema,
    },
    ordersController.postConfirm,
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

  app.post(
    '/status',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: ordersSchema.postOrdersStatusSchema,
    },
    ordersController.postOrdersStatus,
  );

  app.patch(
    '/:orderId/status',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('orderId')],
      schema: ordersSchema.patchOrderStatusSchema,
    },
    ordersController.putOrderStatus,
  );

  // items of an own order that lost its reservation (unconfirmed)
  app.post(
    '/:orderId/items',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('orderId')],
      schema: ordersSchema.postOrderItemsSchema,
    },
    ordersController.postOrderItems,
  );

  app.patch(
    '/:orderId/items/:itemId',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('orderId'), validateId('itemId')],
      schema: ordersSchema.patchOrderItemsSchema,
    },
    ordersController.patchOrderItems,
  );

  app.delete(
    '/:orderId/items/:itemId',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('orderId'), validateId('itemId')],
      schema: ordersSchema.deleteOrderItemsSchema,
    },
    ordersController.deleteOrderItems,
  );

  app.post(
    '/:orderId/cancel-payment',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('orderId')],
      schema: ordersSchema.postCancelPaymentSchema,
    },
    ordersController.postCancelPayment,
  );

  app.post(
    '/:orderId/cancel',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('orderId')],
      schema: ordersSchema.postCancelOrderSchema,
    },
    ordersController.postCancelOrder,
  );
}

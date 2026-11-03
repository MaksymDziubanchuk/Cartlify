import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { requestLimits } from '../../../plugins/requestLimits.js';
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

  // what the shop pays the carrier, the details of a send
  app.patch(
    '/:orderId/shipments/:shipmentId',
    {
      preHandler: [
        authGuard,
        requireRole(['ADMIN', 'ROOT']),
        validateId('orderId'),
        validateId('shipmentId'),
      ],
      schema: ordersSchema.patchShipmentSchema,
    },
    ordersController.patchShipment,
  );

  // where a paid order goes, corrected by an admin until it is sent
  app.patch(
    '/:orderId/delivery',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('orderId')],
      schema: ordersSchema.patchOrderDeliverySchema,
    },
    ordersController.patchOrderDelivery,
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

  // the buyer withdraws from the contract, and tells how they sent the goods back
  app.post(
    '/:orderId/withdrawal',
    {
      preHandler: [
        authGuard,
        requireRole(['USER']),
        validateId('orderId'),
        ...requestLimits.withdrawal,
      ],
      // a withdrawal from the whole order may come without a body
      preValidation: async (req) => {
        if (req.body === undefined || req.body === null) (req as any).body = {};
      },
      schema: ordersSchema.postWithdrawalSchema,
    },
    ordersController.postWithdrawal,
  );

  app.post(
    '/:orderId/returns/:returnId/proof',
    {
      preHandler: [
        authGuard,
        requireRole(['USER']),
        validateId('orderId'),
        validateId('returnId'),
        ...requestLimits.proof,
      ],
      schema: ordersSchema.postReturnProofSchema,
    },
    ordersController.postReturnProof,
  );

  app.post(
    '/:orderId/cancel-payment',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('orderId')],
      schema: ordersSchema.postCancelPaymentSchema,
    },
    ordersController.postCancelPayment,
  );
}

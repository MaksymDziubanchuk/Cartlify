import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { ordersSchema } from './orders.schemas.js';

export default async function ordersRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
      schema: ordersSchema.getOrdersSchema,
    },
    async () => {
      return {
        message: 'orders not implemented',
      };
    },
  );
  app.get(
    '/:orderId',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT']), validateId('orderId')],
      schema: ordersSchema.getOrderByIdSchema,
    },
    async () => {
      return {
        message: 'order by id not implemented',
      };
    },
  );
  app.post(
    '/',
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: ordersSchema.postOrderSchema,
    },
    async () => {
      return {
        message: 'create order not implemented',
      };
    },
  );
  app.put(
    '/:orderId/status',
    {
      preHandler: [authGuard, requireRole(['ADMIN']), validateId('orderId')],
      schema: ordersSchema.putOrderStatusSchema,
    },
    async () => {
      return {
        message: 'update order status not implemented',
      };
    },
  );
}

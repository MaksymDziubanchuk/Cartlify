import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { adminSchema } from './admin.schemas.js';
import { adminController } from './admin.controllers.js';

export default async function adminRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/stats',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getStatsSchema,
    },
    adminController.getAllStats,
  );
  app.post(
    '/products/:productId/popularity',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('productId')],
      schema: adminSchema.setProductPopularity,
    },
    adminController.postProductPopularity,
  );
  app.get(
    '/chats',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getChatsSchema,
    },
    adminController.getAdminsChats,
  );
}

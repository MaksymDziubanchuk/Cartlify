import type { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { adminSchema } from './admin.schemas.js';
import { adminController } from './admin.controllers.js';

export default async function adminRouter(app: FastifyInstance) {
  app.get(
    '/stats',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: adminSchema.getStatsSchema,
    },
    adminController.getAllStats,
  );
}
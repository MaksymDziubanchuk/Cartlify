import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { rootAdminsSchemas } from './root.schemas.js';
import { rootAdminsController } from './root.controllers.js';

export default async function rootRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/admins',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootAdminsSchemas.getRootAdminsSchema,
    },
    rootAdminsController.getAdmins,
  );
  app.post(
    '/admins',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootAdminsSchemas.postRootAdminSchema,
    },
    rootAdminsController.postAdmin,
  );
  app.delete(
    '/admins/:adminId',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootAdminsSchemas.deleteRootAdminSchema,
    },
    rootAdminsController.deleteAdmin,
  );
}

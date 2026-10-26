import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { rootAdminsSchemas } from './root.schemas.js';
import { rootAdminsController } from './root.controllers.js';
import { legalController } from '../legal/legal.controllers.js';
import { rootLegalSchemas } from '../legal/legal.schemas.js';

export default async function rootRouter(app: FastifyInstance) {
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
      preHandler: [authGuard, requireRole(['ROOT']), validateId('adminId')],
      schema: rootAdminsSchemas.deleteRootAdminSchema,
    },
    rootAdminsController.deleteAdmin,
  );

  // the versions of the terms and of the contract
  app.post(
    '/legal-documents',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootLegalSchemas.postRootLegalDocumentSchema,
    },
    legalController.postDocument,
  );
  app.get(
    '/legal-documents',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: rootLegalSchemas.getRootLegalDocumentsSchema,
    },
    legalController.getDocuments,
  );
}

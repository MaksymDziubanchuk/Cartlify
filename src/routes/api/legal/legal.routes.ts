import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { legalSchemas } from './legal.schemas.js';
import { legalController } from './legal.controllers.js';

// the terms and the contract: everybody reads the versions, a customer accepts them; root
// publishes them under /api/root/legal-documents (root.routes.ts)
export default async function legalRouter(app: FastifyInstance) {
  app.get(
    '/documents/current',
    { schema: legalSchemas.getCurrentLegalDocumentsSchema },
    legalController.getCurrentDocuments,
  );
  app.get(
    '/documents/:documentId',
    {
      preHandler: [validateId('documentId')],
      schema: legalSchemas.getLegalDocumentSchema,
    },
    legalController.getDocument,
  );
  app.get(
    '/acceptances/me',
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: legalSchemas.getLegalAcceptanceStatusSchema,
    },
    legalController.getAcceptanceStatus,
  );
  app.post(
    '/acceptances',
    {
      preHandler: [authGuard, requireRole(['USER'])],
      schema: legalSchemas.acceptLegalDocumentsSchema,
    },
    legalController.postAcceptances,
  );
}

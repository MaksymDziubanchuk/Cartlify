import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { documentsSchema } from './documents.schemas.js';
import { documentsController } from './documents.controllers.js';

// the directory of the documents (instructions, certificates) products name, for an admin or a
// root; the buyer opens a document from the card of a product
export default async function documentsRouter(app: FastifyInstance) {
  app.post(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      // a form only, with no json body to check: the controller reads and checks its parts
      schema: documentsSchema.postDocumentSchema,
      config: { formBodySchema: 'documentsCreateFormSchema' },
    },
    documentsController.postDocument,
  );
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: documentsSchema.getDocumentsSchema,
    },
    documentsController.getDocuments,
  );
  app.get(
    '/:documentId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('documentId')],
      schema: documentsSchema.getDocumentSchema,
    },
    documentsController.getDocument,
  );
  app.patch(
    '/:documentId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('documentId')],
      schema: documentsSchema.patchDocumentSchema,
    },
    documentsController.patchDocument,
  );
  app.delete(
    '/:documentId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('documentId')],
      schema: documentsSchema.deleteDocumentSchema,
    },
    documentsController.deleteDocument,
  );
}

import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { attributesSchema as schema } from './attributes.schemas.js';
import { attributesController as controller } from './attributes.controllers.js';

// the characteristics a category asks for, for an admin or a root. The routes are under
// /api/categories, next to the others of a category
export default async function categoryAttributesRouter(app: FastifyInstance) {
  const preHandler = [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('categoryId')];

  app.get(
    '/:categoryId/attributes',
    { preHandler, schema: schema.getCategoryAttributes },
    controller.getCategoryAttributes,
  );
  app.put(
    '/:categoryId/attributes',
    { preHandler, schema: schema.putCategoryAttributes },
    controller.putCategoryAttributes,
  );
}

import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { categoriesSchema } from './categories.schemas.js';
import { categoriesController } from './categories.controllers.js';

export default async function categoriesRouter(app: FastifyInstance) {
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'ADMIN', 'ROOT', 'USER'])],
      schema: categoriesSchema.getCategoriesSchema,
    },
    categoriesController.getCategories,
  );
  app.get(
    '/tree',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'ADMIN', 'ROOT', 'USER'])],
      schema: categoriesSchema.getCategoryTreeSchema,
    },
    categoriesController.getCategoryTree,
  );
  app.post(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: categoriesSchema.postCategorySchema,
    },
    categoriesController.postCategory,
  );
  app.patch(
    '/:categoryId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('categoryId')],
      schema: categoriesSchema.patchCategorySchema,
    },
    categoriesController.patchCategory,
  );
  app.put(
    '/:categoryId/image',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('categoryId')],
      // a form only, with no json body to check: the controller reads and checks its part
      schema: categoriesSchema.putCategoryImageSchema,
      config: { formBodySchema: 'categoriesImageFormSchema' },
    },
    categoriesController.putCategoryImage,
  );
  app.delete(
    '/:categoryId/image',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('categoryId')],
      schema: categoriesSchema.deleteCategoryImageSchema,
    },
    categoriesController.deleteCategoryImage,
  );
  app.delete(
    '/:categoryId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('categoryId')],
      schema: categoriesSchema.deleteCategorySchema,
    },
    categoriesController.deleteCategory,
  );
}

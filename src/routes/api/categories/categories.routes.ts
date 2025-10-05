import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { categoriesSchema } from './categories.schemas.js';

export default async function categoriesRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'ADMIN', 'ROOT', 'USER'])],
      schema: categoriesSchema.getCategoriesSchema,
    },
    async () => {
      return {
        message: 'categories not implemented',
      };
    },
  );
  app.post(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN'])],
      schema: categoriesSchema.postCategorySchema,
    },
    async () => {
      return {
        message: 'create category not implemented',
      };
    },
  );
  app.patch(
    '/:categoryId',
    {
      preHandler: [authGuard, requireRole(['ADMIN']), validateId('categoryId')],
      schema: categoriesSchema.patchCategorySchema,
    },
    async () => {
      return {
        message: 'update category not implemented',
      };
    },
  );
  app.delete(
    '/:categoryId',
    {
      preHandler: [authGuard, requireRole(['ADMIN']), validateId('categoryId')],
      schema: categoriesSchema.getCategoriesSchema,
    },
    async () => {
      return {
        message: 'delete category not implemented',
      };
    },
  );
}

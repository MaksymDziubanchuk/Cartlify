import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { favoritesSchema } from './favorites.schemas.js';
import { favoritesController } from './favorites.controllers.js';

export default async function favoritesRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER', 'ADMIN', 'ROOT'])],
      schema: favoritesSchema.getFavoritesSchema,
    },
    favoritesController.getFavorites,
  );
  app.post(
    '/:productId/toggle',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER']), validateId('productId')],
      schema: favoritesSchema.postToggleFavoriteSchema,
    },
    favoritesController.postToggleFavorite,
  );
  app.delete(
    '/:productId',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER']), validateId('productId')],
      schema: favoritesSchema.deleteFavoriteSchema,
    },
    favoritesController.deleteFavorite,
  );
}

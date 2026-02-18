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
      preHandler: [authGuard, requireRole(['GUEST', 'USER'])],
      schema: favoritesSchema.getFavoritesSchema,
    },
    favoritesController.getFavorites,
  );
  app.post(
    '/:productId',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER']), validateId('productId')],
      schema: favoritesSchema.postAddFavoriteSchema,
    },
    favoritesController.postAddFavorite,
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

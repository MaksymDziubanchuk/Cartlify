import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { usersSchema } from './users.schemas.js';
import { usersController } from './users.controllers.js';

export default async function usersRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/me',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT', 'USER'])],
      schema: usersSchema.getMeSchema,
    },
    usersController.getMe,
  );
  app.patch(
    '/me',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT', 'USER'])],
      schema: usersSchema.patchMeSchema,
    },
    usersController.patchMe,
  );
  app.get(
    '/:userId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT', 'USER']), validateId('userId')],
      schema: usersSchema.getUserByIdSchema,
    },
    usersController.getUserById,
  );
}

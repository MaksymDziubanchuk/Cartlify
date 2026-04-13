import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { chatsSchemas } from './chat.schemas.js';

export default async function chatRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'ADMIN', 'ROOT', 'USER'])],
      schema: chatsSchemas.getChatsSchema,
    },
    async () => {
      return {
        message: 'chat not implemented',
      };
    },
  );
}

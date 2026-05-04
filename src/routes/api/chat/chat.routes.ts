import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { chatsSchemas } from './chat.schemas.js';
import { chatController } from './chat.controllers.js';

export default async function chatRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/threads',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER', 'ADMIN', 'ROOT'])],
      schema: chatsSchemas.getChatsSchema,
    },
    chatController.getThreads
  );
  app.get(
    '/threads/:threadId/messages',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER', 'ADMIN', 'ROOT'])],
      schema: chatsSchemas.getChatMessagesSchema,
    },
    chatController.getThreadMessage
  );
  app.post(
    '/threads',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER', 'ADMIN', 'ROOT'])],
      schema: chatsSchemas.createChatThreadSchema,
    },
    chatController.postThread
  );
  app.post(
    '/threads/:threadId/messages',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER', 'ADMIN', 'ROOT'])],
      schema: chatsSchemas.createChatMessageSchema,
    },
    async () => {
      return {
        message: 'create chat message not implemented',
      };
    },
  );
}

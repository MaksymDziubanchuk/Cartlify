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
    async () => {
      return {
        message: 'get chat messages not implemented',
      };
    },
  );
  app.post(
    '/threads',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER', 'ADMIN', 'ROOT'])],
      schema: chatsSchemas.createChatThreadSchema,
    },
    async () => {
      return {
        message: 'create chat thread not implemented',
      };
    },
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

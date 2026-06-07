import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import { chatsSchemas } from './chat.schemas.js';
import { chatController } from './chat.controllers.js';
import { chatWsController } from './ws/chatWs.controller.js';

export default async function chatRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/thread/current',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER'])],
      schema: chatsSchemas.getCurrentChatSchema,
    },
    chatController.getCurrentChat,
  );

  app.get(
    '/admin/threads',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: chatsSchemas.getAdminChatThreadsSchema,
    },
    chatController.getAdminChatThreads,
  );

  app.get(
    '/admin/threads/:threadId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: chatsSchemas.getAdminChatThreadSchema,
    },
    chatController.getAdminChatThread,
  );

  app.patch(
    '/admin/threads/:threadId/close',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: chatsSchemas.closeAdminChatThreadSchema,
    },
    chatController.closeAdminChatThread,
  );

  app.get(
    '/ws',
    {
      websocket: true,
      preHandler: [authGuard, requireRole(['GUEST', 'USER', 'ADMIN', 'ROOT'])],
    },
    chatWsController.connectChatWs,
  );
}
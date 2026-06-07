import type { ControllerRouter } from 'types/controller.js';
import { chatWsBroadcaster } from './ws/chatWs.broadcaster.js';
import { chatWsConnectionManager } from './ws/chatWs.connectionManager.js';
import type {
    AdminChatThreadResponseDto,
    AdminChatThreadsQueryDto,
    AdminChatThreadsResponseDto,
    ChatThreadIdParamsDto,
    CloseChatThreadDto,
    CloseChatThreadResponseDto,
    GetCurrentChatDto,
    CurrentChatResponseDto,
    FindAdminChatThreadDto,
    FindAdminChatThreadsDto,
} from 'types/dto/chats.dto.js';
import type { User } from 'types/user.js';

import pickDefined from '@helpers/parameterNormalize.js';
import { chatsServices } from './chat.services.js';

const getCurrentChat: ControllerRouter<{}, {}, {}, CurrentChatResponseDto> = async (
    req,
    reply,
) => {
    const { id: actorId, role: actorRole } = req.user as User;

    const args = pickDefined<GetCurrentChatDto>({ actorId, actorRole }, {});

    const result = await chatsServices.getCurrentChatService(args);
    return reply.code(200).send(result);
};

const getAdminChatThreads: ControllerRouter<
    {},
    {},
    AdminChatThreadsQueryDto,
    AdminChatThreadsResponseDto
> = async (req, reply) => {
    const { id: actorId, role: actorRole } = req.user as User;
    const { page, limit, queue } = req.query;

    const args = pickDefined<FindAdminChatThreadsDto>(
        {
            actorId,
            actorRole,
            page: page ?? 1,
            limit: limit ?? 20,
            queue: queue ?? 'waiting',
        },
        {},
    );

    const result = await chatsServices.getAdminChatThreadsService(args);

    return reply.code(200).send(result);
};

const getAdminChatThread: ControllerRouter<
    ChatThreadIdParamsDto,
    {},
    {},
    AdminChatThreadResponseDto
> = async (req, reply) => {
    const { id: actorId, role: actorRole } = req.user as User;
    const { threadId } = req.params;

    const args = pickDefined<FindAdminChatThreadDto>(
        {
            actorId,
            actorRole,
            threadId,
        },
        {},
    );

    const result = await chatsServices.getAdminChatThreadService(args);

    return reply.code(200).send(result);
};

const closeAdminChatThread: ControllerRouter<
    ChatThreadIdParamsDto,
    {},
    {},
    CloseChatThreadResponseDto
> = async (req, reply) => {
    const { id: actorId, role: actorRole } = req.user as User;
    const { threadId } = req.params;

    const args = pickDefined<CloseChatThreadDto>(
        {
            actorId,
            actorRole,
            threadId,
        },
        {},
    );

    const result = await chatsServices.closeAdminChatThreadService(args);

    // notify active thread sockets
    chatWsBroadcaster.broadcastToThread(threadId, {
        type: 'thread:closed',
        payload: {
            thread: result.thread,
        },
    });

    // remove sockets from closed thread room
    chatWsConnectionManager.removeThread(threadId);

    return reply.code(200).send(result);
};

export const chatController = {
    getCurrentChat,
    getAdminChatThreads,
    getAdminChatThread,
    closeAdminChatThread,
};
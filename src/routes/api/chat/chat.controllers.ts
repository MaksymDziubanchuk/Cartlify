import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type {
    GetChatThreadsQueryDto,
    GetChatMessagesQueryDto,
    CreateChatThreadBodyDto,
    CreateChatMessageBodyDto,
    ChatThreadIdParamsDto
} from 'types/dto/chats.dto.js';

import { chatsServices } from './chat.services.js';
import { User } from '@prisma/client';
import type { UserEntity } from 'types/user.js';

const getThreads: ControllerRouter<
    ChatThreadIdParamsDto,
    {},
    GetChatThreadsQueryDto,
    MessageResponseDto
> = async (req, reply) => {
    const query = req.query;
    const { id, role } = req.user as UserEntity;


    return chatsServices.getThreads();
};

const getThreadMessage: ControllerRouter<{}, {}, GetChatMessagesQueryDto, MessageResponseDto> = async (
    req,
    reply,
) => {
    const { id, role } = req.user as UserEntity;

    return chatsServices.getThreadMessage();
};

const postThread: ControllerRouter<{}, CreateChatThreadBodyDto, {}, MessageResponseDto> = async (
    req,
    reply,
) => {
    const { id, role } = req.user as UserEntity;
    const body = req.body;
    return chatsServices.postThread();
};

const postThreadMessage: ControllerRouter<{}, CreateChatMessageBodyDto, {}, MessageResponseDto> = async (
    req,
    reply,
) => {
    const { id, role } = req.user as UserEntity;
    return chatsServices.postThreadMessage();
};

export const chatController = {
    getThreads,
    getThreadMessage,
    postThread,
    postThreadMessage,
};
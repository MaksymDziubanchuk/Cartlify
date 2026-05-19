import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { GetChatThreadsQueryDto, GetChatMessagesQueryDto, CreateChatThreadBodyDto } from 'types/dto/chats.dto.js';

import { chatsServices } from './chat.services.js';

const getThreads: ControllerRouter<
    {},
    {},
    GetChatThreadsQueryDto,
    MessageResponseDto
> = async (req, reply) => {
    const query = req.query;

    return chatsServices.getThreads();
};

const getThreadMessage: ControllerRouter<{}, {}, GetChatMessagesQueryDto, MessageResponseDto> = async (
    req,
    reply,
) => {
    return chatsServices.getThreadMessage();
};

const postThread: ControllerRouter<{}, CreateChatThreadBodyDto, {}, MessageResponseDto> = async (
    req,
    reply,
) => {
    return chatsServices.postThread();
};

const postThreadMessage: ControllerRouter<{}, {}, {}, MessageResponseDto> = async (
    req,
    reply,
) => {
    return chatsServices.postThreadMessage();
};

export const chatController = {
    getThreads,
    getThreadMessage,
    postThread,
    postThreadMessage,
};
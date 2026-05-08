import type { MessageResponseDto } from 'types/common.js';

const getThreads = async (): Promise<MessageResponseDto> => {
    return {
        message: 'get chat threads not implemented',
    };
};

const getThreadMessage = async (): Promise<MessageResponseDto> => {
    return {
        message: 'get chat messages not implemented',
    };
};

const postThread = async (): Promise<MessageResponseDto> => {
    return {
        message: 'create chat thread not implemented',
    };
};

const postThreadMessage = async (): Promise<MessageResponseDto> => {
    return {
        message: 'create chat message not implemented',
    };
};

export const chatsServices = {
    getThreads,
    getThreadMessage,
    postThread,
    postThreadMessage,
};
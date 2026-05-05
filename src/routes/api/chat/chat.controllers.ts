import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';

import pickDefined from '@helpers/parameterNormalize.js';


const getThreads: ControllerRouter<{}, {}, {}, MessageResponseDto> = async (req, reply) => {

    const { id: actorId, role: actorRole } = req.user as UserEntity;

    return {
        message: 'get chat threads not implemented',
    };
};

const getThreadMessage: ControllerRouter<{}, {}, {}, MessageResponseDto> = async (req, reply) => {

    return {
        message: 'get chat messages not implemented',
    };
};

const postThread: ControllerRouter<{}, {}, {}, MessageResponseDto> = async (req, reply) => {

    return {
        message: 'create chat thread not implemented',
    };
};

const postThreadMessage: ControllerRouter<{}, {}, {}, MessageResponseDto> = async (req, reply) => {

    return {
        message: 'create chat message not implemented',
    };
};

export const chatController = {
    getThreads,
    getThreadMessage,
    postThread,
    postThreadMessage
};

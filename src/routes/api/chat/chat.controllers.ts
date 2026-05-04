import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';

import pickDefined from '@helpers/parameterNormalize.js';


const getThreads: ControllerRouter<{}, {}, {}, MessageResponseDto> = async (req, reply) => {

    return {
        message: 'get chat threads not implemented',
    };
};



export const chatController = {
    getThreads
};

import { closeAdminChatThreadService } from './services/closeAdminChatThread.service.js';
import { getAdminChatThreadService } from './services/getAdminChatThread.service.js';
import { getAdminChatThreadsService } from './services/getAdminChatThreads.service.js';
import { getCurrentChatService } from './services/getCurrentChat.service.js';
import { markChatThreadReadService } from './services/markChatThreadRead.service.js';
import { requestAdminService } from './services/requestAdmin.service.js';
import { sendChatMessageService } from './services/sendChatMessage.service.js';

export const chatsServices = {
    getCurrentChatService,
    getAdminChatThreadsService,
    getAdminChatThreadService,
    closeAdminChatThreadService,
    markChatThreadReadService,
    requestAdminService,
    sendChatMessageService,
};
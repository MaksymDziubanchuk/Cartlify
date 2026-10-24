import { closeAdminChatThreadService } from './services/closeAdminChatThread.service.js';
import { getAdminChatThreadService } from './services/getAdminChatThread.service.js';
import { getAdminChatThreadsService } from './services/getAdminChatThreads.service.js';
import { getChatThreadMessagesService } from './services/getChatThreadMessages.service.js';
import { getCurrentChatService } from './services/getCurrentChat.service.js';
import { markChatThreadReadService } from './services/markChatThreadRead.service.js';
import { sendChatMessageService } from './services/sendChatMessage.service.js';

export const chatsServices = {
    getCurrentChatService,
    getChatThreadMessagesService,
    getAdminChatThreadsService,
    getAdminChatThreadService,
    closeAdminChatThreadService,
    markChatThreadReadService,
    sendChatMessageService,
};
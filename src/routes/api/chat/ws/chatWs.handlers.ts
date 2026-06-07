import type { RawData } from 'ws';

import { isAppError } from '@utils/errors.js';

import { assertChatThreadAccessService } from '../services/assertChatThreadAccess.service.js';
import { markChatThreadReadService } from '../services/markChatThreadRead.service.js';
import { sendChatMessageService } from '../services/sendChatMessage.service.js';
import { chatWsBroadcaster } from './chatWs.broadcaster.js';
import { chatWsConnectionManager } from './chatWs.connectionManager.js';
import { ChatWsParseError } from './chatWs.errors.js';
import { parseChatWsEvent } from './chatWs.parser.js';

interface HandleWsMessageDto {
    socketId: string;
    raw: RawData;
}

// handle thread join
async function handleThreadJoin(socketId: string, threadId: string): Promise<void> {
    const context = chatWsConnectionManager.getContext(socketId);

    if (!context) {
        chatWsBroadcaster.sendError(socketId, {
            code: 'SOCKET_CONTEXT_NOT_FOUND',
        });

        return;
    }

    // check thread access
    await assertChatThreadAccessService({
        actorId: context.actorId,
        actorRole: context.actorRole,
        threadId,
    });

    // attach socket to thread
    chatWsConnectionManager.joinThread(socketId, threadId);

    // confirm join
    chatWsBroadcaster.sendToSocket(socketId, {
        type: 'thread:joined',
        payload: {
            threadId,
        },
    });
}

// handle message send
async function handleMessageSend(
    socketId: string,
    threadId: string,
    content: string,
): Promise<void> {
    const context = chatWsConnectionManager.getContext(socketId);

    if (!context) {
        chatWsBroadcaster.sendError(socketId, {
            code: 'SOCKET_CONTEXT_NOT_FOUND',
        });

        return;
    }

    // require joined thread
    if (!context.joinedThreads.has(threadId)) {
        chatWsBroadcaster.sendError(socketId, {
            code: 'THREAD_NOT_JOINED',
        });

        return;
    }

    // save message
    const result = await sendChatMessageService({
        actorId: context.actorId,
        actorRole: context.actorRole,
        threadId,
        content,
    });

    // broadcast sender message
    chatWsBroadcaster.broadcastToThread(threadId, {
        type: 'message:new',
        payload: result.message,
    });

    // broadcast bot message
    if (result.botMessage) {
        chatWsBroadcaster.broadcastToThread(threadId, {
            type: 'message:new',
            payload: result.botMessage,
        });
    }

    // notify admins
    if (result.adminRequested) {
        chatWsBroadcaster.broadcastToAdmins({
            type: 'admin:requested',
            payload: {
                thread: result.thread,
            },
        });
    }
}

// handle thread read
async function handleThreadRead(socketId: string, threadId: string): Promise<void> {
    const context = chatWsConnectionManager.getContext(socketId);

    if (!context) {
        chatWsBroadcaster.sendError(socketId, {
            code: 'SOCKET_CONTEXT_NOT_FOUND',
        });

        return;
    }

    // require joined thread
    if (!context.joinedThreads.has(threadId)) {
        chatWsBroadcaster.sendError(socketId, {
            code: 'THREAD_NOT_JOINED',
        });

        return;
    }

    // mark customer messages as read
    const result = await markChatThreadReadService({
        actorId: context.actorId,
        actorRole: context.actorRole,
        threadId,
    });

    // broadcast read state
    chatWsBroadcaster.broadcastToThread(threadId, {
        type: 'thread:read',
        payload: {
            thread: result.thread,
            readerId: context.actorId,
            readerRole: context.actorRole,
        },
    });
}

// handle typing event
async function handleTyping(
    socketId: string,
    threadId: string,
    type: 'typing:start' | 'typing:stop',
): Promise<void> {
    const context = chatWsConnectionManager.getContext(socketId);

    if (!context) {
        chatWsBroadcaster.sendError(socketId, {
            code: 'SOCKET_CONTEXT_NOT_FOUND',
        });

        return;
    }

    // require joined thread
    if (!context.joinedThreads.has(threadId)) {
        chatWsBroadcaster.sendError(socketId, {
            code: 'THREAD_NOT_JOINED',
        });

        return;
    }

    // check thread access
    await assertChatThreadAccessService({
        actorId: context.actorId,
        actorRole: context.actorRole,
        threadId,
    });

    // broadcast typing state
    chatWsBroadcaster.broadcastToThread(threadId, {
        type,
        payload: {
            threadId,
            actorId: context.actorId,
            actorRole: context.actorRole,
        },
    });
}

// handle raw ws message
async function handleMessage({ socketId, raw }: HandleWsMessageDto): Promise<void> {
    try {
        // parse client event
        const event = parseChatWsEvent(raw);

        // route event
        switch (event.type) {
            case 'thread:join':
                await handleThreadJoin(socketId, event.payload.threadId);
                return;

            case 'message:send':
                await handleMessageSend(
                    socketId,
                    event.payload.threadId,
                    event.payload.content,
                );
                return;

            case 'thread:read':
                await handleThreadRead(socketId, event.payload.threadId);
                return;

            case 'typing:start':
                await handleTyping(socketId, event.payload.threadId, 'typing:start');
                return;

            case 'typing:stop':
                await handleTyping(socketId, event.payload.threadId, 'typing:stop');
                return;

            default:
                chatWsBroadcaster.sendError(socketId, {
                    code: 'UNKNOWN_EVENT_TYPE',
                });
        }
    } catch (err) {
        // handle parser error
        if (err instanceof ChatWsParseError) {
            chatWsBroadcaster.sendError(socketId, {
                code: err.code,
            });

            return;
        }

        // handle app error
        if (isAppError(err)) {
            chatWsBroadcaster.sendError(socketId, {
                code: err.errorCode,
            });

            return;
        }

        // handle unexpected error
        chatWsBroadcaster.sendError(socketId, {
            code: 'CHAT_WS_UNEXPECTED',
        });
    }
}

export const chatWsHandlers = {
    handleMessage,
};
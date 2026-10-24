import type { RawData } from 'ws';

import { isAppError } from '@utils/errors.js';

import { assertChatThreadAccessService } from '../services/assertChatThreadAccess.service.js';
import { markChatThreadReadService } from '../services/markChatThreadRead.service.js';
import { sendChatMessageService } from '../services/sendChatMessage.service.js';
import type { ChatBotLogger } from '../services/bot/chatBotAi.service.js';
import { chatWsBroadcaster } from './chatWs.broadcaster.js';
import { chatWsConnectionManager } from './chatWs.connectionManager.js';
import { ChatWsParseError } from './chatWs.errors.js';
import { parseChatWsEvent, peekChatWsEventType } from './chatWs.parser.js';
import { limitKindOf } from './chatWs.limits.js';
import { readActorRole } from '@db/actorRole.helper.js';

// the codes a socket closes with: over a limit, and a session to renew (as chatWs.controller.ts)
const LIMIT_CLOSE_CODE = 1008;
const SESSION_CLOSE_CODE = 4401;

const closeSocket = (socketId: string, code: number, reason: string) =>
    chatWsConnectionManager.getSocket(socketId)?.close(code, reason);

interface HandleWsMessageDto {
    socketId: string;
    raw: RawData;
    log: ChatBotLogger;
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
    log: ChatBotLogger,
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

    // save message; the chat sees it and the admins hear of it once it is written, before the bot
    // has answered it
    const result = await sendChatMessageService({
        actorId: context.actorId,
        actorRole: context.actorRole,
        threadId,
        content,
        log,
        onSaved: (saved) => {
            // broadcast sender message
            chatWsBroadcaster.broadcastToThread(threadId, {
                type: 'message:new',
                payload: saved.message,
            });

            // notify admins
            if (saved.adminRequested) {
                chatWsBroadcaster.broadcastToAdmins({
                    type: 'admin:requested',
                    payload: {
                        thread: saved.thread,
                    },
                });
            }
        },
    });

    // broadcast bot message
    if (result.botMessage) {
        chatWsBroadcaster.broadcastToThread(threadId, {
            type: 'message:new',
            payload: result.botMessage,
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
async function handleMessage({ socketId, raw, log }: HandleWsMessageDto): Promise<void> {
    const context = chatWsConnectionManager.getContext(socketId);

    // every frame counts, a message and a typing event count toward their own limits too, also
    // the ones that turn out to be broken
    const kind = limitKindOf(peekChatWsEventType(raw) ?? '');
    if (
        context &&
        (!context.limits.allow('frames') || (kind !== null && !context.limits.allow(kind)))
    ) {
        closeSocket(socketId, LIMIT_CLOSE_CODE, 'TOO_MANY_MESSAGES');
        return;
    }

    try {
        // the role of an admin socket is read again before each step: root may have taken it
        // away, the access token still names it until it runs out
        if (context && (context.actorRole === 'ADMIN' || context.actorRole === 'ROOT')) {
            const role = await readActorRole(Number(context.actorId));
            if (role !== context.actorRole) {
                closeSocket(socketId, SESSION_CLOSE_CODE, 'ROLE_CHANGED');
                return;
            }
        }

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
                    log,
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

        // handle app error; a server error is ours, so it goes to the log as well
        if (isAppError(err)) {
            if (err.statusCode >= 500) log.error({ err, socketId }, 'chat ws message failed');

            chatWsBroadcaster.sendError(socketId, {
                code: err.errorCode,
            });

            return;
        }

        // handle unexpected error
        log.error({ err, socketId }, 'chat ws message failed unexpectedly');
        chatWsBroadcaster.sendError(socketId, {
            code: 'CHAT_WS_UNEXPECTED',
        });
    }
}

export const chatWsHandlers = {
    handleMessage,
};
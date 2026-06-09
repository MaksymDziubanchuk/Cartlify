import { randomUUID } from 'node:crypto';

import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import {
    BadRequestError,
    ForbiddenError,
    InternalError,
    isAppError,
} from '@utils/errors.js';

import type {
    CurrentChatResponseDto,
    GetCurrentChatDto,
} from 'types/dto/chats.dto.js';

// normalize user id
function toUserId(actorId: string | number): number {
    const id = typeof actorId === 'number' ? actorId : Number(actorId);

    if (!Number.isInteger(id) || id <= 0) {
        throw new BadRequestError('USER_ID_INVALID');
    }

    return id;
}

const CHAT_WELCOME_MESSAGE =
    'Hi! I am Cartlify assistant. I can help you find products, answer store questions, or connect you with an admin if needed. How can I help?';

const CHAT_MESSAGE_PREVIEW_LIMIT = 120;

// builds short thread preview from message content
function buildChatMessagePreview(content: string): string {
    return content.slice(0, CHAT_MESSAGE_PREVIEW_LIMIT);
}

export async function getCurrentChatService({
    actorId,
    actorRole,
}: GetCurrentChatDto): Promise<CurrentChatResponseDto> {
    // check customer access
    if (actorRole !== 'GUEST' && actorRole !== 'USER') {
        throw new ForbiddenError('CHAT_CURRENT_FORBIDDEN');
    }

    try {
        return await prisma.$transaction(async (tx) => {
            // set rls session context
            await setActorContext(tx, {
                actorId,
                role: actorRole,
            });

            // build active thread filter
            const where =
                actorRole === 'GUEST'
                    ? {
                        guestId: String(actorId),
                        status: 'open' as const,
                    }
                    : {
                        userId: toUserId(actorId),
                        status: 'open' as const,
                    };

            // find active thread
            let thread = await tx.chatThread.findFirst({
                where,
                orderBy: {
                    lastMessageAt: 'desc',
                },
            });

            // create initial bot thread
            // create initial bot thread with welcome message
            if (!thread) {
                const threadId = randomUUID();
                const welcomeCreatedAt = new Date();

                thread = await tx.chatThread.create({
                    data:
                        actorRole === 'GUEST'
                            ? {
                                id: threadId,
                                guestId: String(actorId),
                                type: 'bot',
                                status: 'open',
                                lastMessageAt: welcomeCreatedAt,
                                lastMessagePreview: buildChatMessagePreview(
                                    CHAT_WELCOME_MESSAGE,
                                ),
                            }
                            : {
                                id: threadId,
                                userId: toUserId(actorId),
                                type: 'bot',
                                status: 'open',
                                lastMessageAt: welcomeCreatedAt,
                                lastMessagePreview: buildChatMessagePreview(
                                    CHAT_WELCOME_MESSAGE,
                                ),
                            },
                });

                await tx.chatMessage.create({
                    data: {
                        threadId: thread.id,
                        senderId: null,
                        senderType: 'bot',
                        content: CHAT_WELCOME_MESSAGE,
                        isRead: true,
                        createdAt: welcomeCreatedAt,
                    },
                });
            }

            // load thread history
            const messages = await tx.chatMessage.findMany({
                where: {
                    threadId: thread.id,
                },
                orderBy: {
                    createdAt: 'asc',
                },
            });

            // return widget payload
            return {
                thread,
                messages,
                ws: {
                    url: '/api/chat/ws',
                    threadId: thread.id,
                },
            };
        });
    } catch (err) {
        if (isAppError(err)) throw err;

        throw new InternalError({ reason: 'CHAT_CURRENT_GET_UNEXPECTED' }, err);
    }
}
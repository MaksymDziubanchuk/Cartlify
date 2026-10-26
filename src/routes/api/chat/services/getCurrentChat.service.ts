import { randomUUID } from 'node:crypto';

import env from '@config/env.js';

import { Prisma } from '@prisma/client';

import { getPgCode, prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import {
    BadRequestError,
    ForbiddenError,
    InternalError,
    isAppError,
} from '@utils/errors.js';

import { readChatHistoryPage } from './helpers/chatHistory.helper.js';

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

// the greeting of a new chat names the shop (SHOP_NAME)
const chatWelcomeMessage = (): string =>
    `Hi! I am ${env.SHOP_NAME} assistant. I can help you find products, answer store questions, or connect you with an admin if needed. How can I help?`;

const CHAT_MESSAGE_PREVIEW_LIMIT = 120;

// builds short thread preview from message content
function buildChatMessagePreview(content: string): string {
    return content.slice(0, CHAT_MESSAGE_PREVIEW_LIMIT);
}

// the index of one open chat of a customer refused a second one
const isOpenChatTaken = (err: unknown): boolean =>
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2002' || getPgCode(err) === '23505');

export async function getCurrentChatService(
    dto: GetCurrentChatDto,
): Promise<CurrentChatResponseDto> {
    // check customer access
    if (dto.actorRole !== 'GUEST' && dto.actorRole !== 'USER') {
        throw new ForbiddenError('CHAT_CURRENT_FORBIDDEN');
    }

    try {
        try {
            return await readCurrentChat(dto);
        } catch (err) {
            // two tabs opened the chat at once: both found none, the other one made it first and
            // the index of one open chat refused this one; it is there to read now
            if (!isOpenChatTaken(err)) throw err;

            return await readCurrentChat(dto);
        }
    } catch (err) {
        if (isAppError(err)) throw err;

        throw new InternalError({ reason: 'CHAT_CURRENT_GET_UNEXPECTED' }, err);
    }
}

// the open chat of the customer with its newest messages, a new chat with the bot when there is none
function readCurrentChat({
    actorId,
    actorRole,
}: GetCurrentChatDto): Promise<CurrentChatResponseDto> {
    return prisma.$transaction(async (tx) => {
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
            const welcomeMessage = chatWelcomeMessage();

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
                                welcomeMessage,
                            ),
                        }
                        : {
                            id: threadId,
                            userId: toUserId(actorId),
                            type: 'bot',
                            status: 'open',
                            lastMessageAt: welcomeCreatedAt,
                            lastMessagePreview: buildChatMessagePreview(
                                welcomeMessage,
                            ),
                        },
            });

            await tx.chatMessage.create({
                data: {
                    threadId: thread.id,
                    senderId: null,
                    senderType: 'bot',
                    content: welcomeMessage,
                    isRead: true,
                    createdAt: welcomeCreatedAt,
                },
            });
        }

        // the newest messages, the ones before come page by page
        const { messages, nextCursor } = await readChatHistoryPage(tx, thread.id);

        // return widget payload
        return {
            thread,
            messages,
            nextCursor,
            ws: {
                url: '/api/chat/ws',
                threadId: thread.id,
            },
        };
    });
}
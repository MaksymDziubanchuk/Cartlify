import { Prisma } from '@prisma/client';

import { isRetryableTxError, tx } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import {
    BadRequestError,
    ConflictError,
    ForbiddenError,
    InternalError,
    isAppError,
    NotFoundError,
    ResourceBusyError,
} from '@utils/errors.js';

import { chatBotService } from './bot/chatBot.service.js';

import type {
    ChatMessageItemDto,
    ChatSenderType,
    ChatThreadItemDto,
} from 'types/dto/chats.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

interface SendChatMessageDto {
    actorId: UserId;
    actorRole: Role;
    threadId: string;
    content: string;
}

interface LockedChatThreadDto {
    id: string;
    userId: number | null;
    guestId: string | null;
    type: 'bot' | 'admin';
    status: 'open' | 'closed';
    adminRequestedAt: Date | null;
    adminUnreadSince: Date | null;
}

interface SendChatMessageResultDto {
    thread: ChatThreadItemDto;
    message: ChatMessageItemDto;
    botMessage: ChatMessageItemDto | null;
    adminRequested: boolean;
}

// normalizes actor id for DB comparisons and senderId writes
function toUserId(actorId: string | number): number {
    const id = typeof actorId === 'number' ? actorId : Number(actorId);

    if (!Number.isInteger(id) || id <= 0) {
        throw new BadRequestError('USER_ID_INVALID');
    }

    return id;
}

// validates and trims customer/admin message content
function normalizeContent(content: string): string {
    const normalized = content.trim();

    if (!normalized) {
        throw new BadRequestError('CHAT_MESSAGE_EMPTY');
    }

    if (normalized.length > 2000) {
        throw new BadRequestError('CHAT_MESSAGE_TOO_LONG');
    }

    return normalized;
}

// resolves stored chat sender type from actor role
function getSenderType(actorRole: Role): ChatSenderType {
    if (actorRole === 'GUEST') return 'guest';
    if (actorRole === 'USER') return 'user';
    if (actorRole === 'ADMIN' || actorRole === 'ROOT') return 'admin';

    throw new ForbiddenError('CHAT_SENDER_FORBIDDEN');
}

// decides whether this message should start one bot turn
function shouldTriggerBotTurn(
    senderType: ChatSenderType,
    thread: ChatThreadItemDto,
): boolean {
    return (
        thread.status === 'open' &&
        thread.type === 'bot' &&
        (senderType === 'guest' || senderType === 'user')
    );
}

// creates the user/admin/guest message inside the thread transaction
async function createChatMessage({
    actorId,
    actorRole,
    threadId,
    normalizedContent,
}: SendChatMessageDto & {
    normalizedContent: string;
}): Promise<SendChatMessageResultDto> {
    return tx(
        async (db) => {
            // applies actor context for RLS-protected chat operations
            await setActorContext(db, {
                actorId,
                role: actorRole,
            });

            // prevents long row-lock waits on busy chat threads
            await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

            // locks target thread before writing a new message
            const lockedThreads = await db.$queryRaw<LockedChatThreadDto[]>`
                SELECT id, "userId", "guestId", type, status, "adminRequestedAt", "adminUnreadSince"
                FROM cartlify.chat_threads
                WHERE id = ${threadId}::uuid
                FOR UPDATE
            `;

            const lockedThread = lockedThreads[0];

            // fails if the target thread does not exist
            if (!lockedThread) {
                throw new NotFoundError('CHAT_THREAD_NOT_FOUND');
            }

            // blocks writing into closed threads
            if (lockedThread.status === 'closed') {
                throw new ConflictError('CHAT_THREAD_CLOSED');
            }

            // checks guest ownership
            if (actorRole === 'GUEST' && lockedThread.guestId !== String(actorId)) {
                throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
            }

            // checks user ownership
            if (actorRole === 'USER' && lockedThread.userId !== toUserId(actorId)) {
                throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
            }

            // allows only valid chat actors
            if (
                actorRole !== 'GUEST' &&
                actorRole !== 'USER' &&
                actorRole !== 'ADMIN' &&
                actorRole !== 'ROOT'
            ) {
                throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
            }

            // resolves message sender type after access checks
            const senderType = getSenderType(actorRole);

            // marks customer messages to bot as read immediately because bot processes them right away
            const isReadByRecipient =
                lockedThread.type === 'bot' &&
                (senderType === 'guest' || senderType === 'user');

            // prevents admins from writing into bot-only threads
            if (senderType === 'admin' && lockedThread.type !== 'admin') {
                throw new ConflictError('CHAT_THREAD_NOT_ESCALATED');
            }

            // prevents guests from writing into admin threads
            if (senderType === 'guest' && lockedThread.type === 'admin') {
                throw new ForbiddenError('CHAT_GUEST_ADMIN_FORBIDDEN');
            }

            // stores the new chat message
            const message = await db.chatMessage.create({
                data: {
                    threadId,
                    senderId:
                        actorRole === 'USER' ||
                            actorRole === 'ADMIN' ||
                            actorRole === 'ROOT'
                            ? toUserId(actorId)
                            : null,
                    senderType,
                    content: normalizedContent,
                    isRead: isReadByRecipient,
                },
            });

            // detects a customer message inside an admin thread
            const adminRequested =
                lockedThread.type === 'admin' &&
                senderType === 'user';

            // detects admin reply inside an admin thread
            const adminAnswered = senderType === 'admin';

            // marks customer messages as read when admin replies
            if (adminAnswered) {
                await db.chatMessage.updateMany({
                    where: {
                        threadId,
                        senderType: {
                            in: ['user', 'guest'],
                        },
                        isRead: false,
                    },
                    data: {
                        isRead: true,
                    },
                });
            }

            // updates thread metadata after message creation
            const thread = await db.chatThread.update({
                where: {
                    id: threadId,
                },
                data: {
                    lastMessageAt: message.createdAt,
                    lastMessagePreview: normalizedContent.slice(0, 120),

                    ...(adminRequested && {
                        unreadCount: { increment: 1 },
                        adminUnreadSince: message.createdAt,
                    }),

                    ...(adminAnswered && {
                        unreadCount: 0,
                        adminRequestedAt: null,
                    }),
                },
            });

            // returns the saved message before optional bot processing
            return {
                thread,
                message,
                botMessage: null,
                adminRequested,
            };
        },
        {
            maxRetries: 3,
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 1500,
            timeout: 10_000,
        },
    );
}

// runs bot after customer message transaction is already committed
async function attachBotTurnIfNeeded({
    actorId,
    actorRole,
    threadId,
    normalizedContent,
    result,
}: SendChatMessageDto & {
    normalizedContent: string;
    result: SendChatMessageResultDto;
}): Promise<SendChatMessageResultDto> {
    // skips bot for admins, admin threads, closed threads, and non-customer senders
    if (!shouldTriggerBotTurn(result.message.senderType, result.thread)) {
        return result;
    }

    try {
        // calls bot outside the message transaction to avoid holding DB locks during AI request
        const botResult = await chatBotService.handleChatBotTurn({
            actorId,
            actorRole,
            threadId,
            userMessageId: result.message.id,
            userMessage: normalizedContent,
        });

        // merges bot result into the original send-message response
        return {
            thread: botResult.thread ?? result.thread,
            message: result.message,
            botMessage: botResult.botMessage,
            adminRequested: result.adminRequested,
        };
    } catch {
        // keeps the customer message successful even if bot processing fails
        return result;
    }
}

export async function sendChatMessageService({
    actorId,
    actorRole,
    threadId,
    content,
}: SendChatMessageDto): Promise<SendChatMessageResultDto> {
    const normalizedContent = normalizeContent(content);

    try {
        // saves the original message first
        const result = await createChatMessage({
            actorId,
            actorRole,
            threadId,
            content,
            normalizedContent,
        });

        // optionally creates bot response after message save
        return await attachBotTurnIfNeeded({
            actorId,
            actorRole,
            threadId,
            content,
            normalizedContent,
            result,
        });
    } catch (err) {
        // preserves known application errors
        if (isAppError(err)) throw err;

        // maps retryable transaction errors to stable resource-busy response
        if (isRetryableTxError(err)) {
            throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
        }

        // wraps unexpected send-message failures
        throw new InternalError({ reason: 'CHAT_MESSAGE_SEND_UNEXPECTED' }, err);
    }
}
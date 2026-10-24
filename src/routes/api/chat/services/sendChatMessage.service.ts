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
import type { ChatBotLogger } from './bot/chatBotAi.service.js';

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
    log: ChatBotLogger;
    // called once the message is written, before the bot answers it: the socket shows the
    // message to the chat right away, the answer of the model takes seconds
    onSaved?: (saved: SendChatMessageResultDto) => void;
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

// the chats the bot answers now, in this server process: one turn of the bot at a time in a chat,
// two would be two paid calls of the model for one conversation and answers in any order
const botTurnsRunning = new Set<string>();

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

    // a NUL sign is no text postgres keeps: the message failed with a server error
    if (normalized.includes('\u0000')) {
        throw new BadRequestError('TEXT_NUL_FORBIDDEN');
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
}: Omit<SendChatMessageDto, 'log' | 'onSaved'> & {
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
                        // an answer before the customer described the problem takes the chat to
                        // the active queue: an open chat of an admin keeps one of the two marks
                        adminUnreadSince: lockedThread.adminUnreadSince ?? message.createdAt,
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
async function attachBotTurn({
    actorId,
    actorRole,
    threadId,
    normalizedContent,
    result,
    log,
}: Omit<SendChatMessageDto, 'onSaved'> & {
    normalizedContent: string;
    result: SendChatMessageResultDto;
}): Promise<SendChatMessageResultDto> {
    try {
        // calls bot outside the message transaction to avoid holding DB locks during AI request
        const botResult = await chatBotService.handleChatBotTurn({
            actorId,
            actorRole,
            threadId,
            userMessageId: result.message.id,
            userMessage: normalizedContent,
            log,
        });

        // merges bot result into the original send-message response
        return {
            thread: botResult.thread ?? result.thread,
            message: result.message,
            botMessage: botResult.botMessage,
            adminRequested: result.adminRequested,
        };
    } catch (err) {
        // keeps the customer message successful even if bot processing fails, but not silently
        log.error({ err, threadId }, 'chat bot turn failed');

        return result;
    }
}

export async function sendChatMessageService({
    actorId,
    actorRole,
    threadId,
    content,
    log,
    onSaved,
}: SendChatMessageDto): Promise<SendChatMessageResultDto> {
    const normalizedContent = normalizeContent(content);

    // a message of the customer while the bot answers the one before is not taken: the widget
    // keeps it and sends it once the answer came
    if ((actorRole === 'GUEST' || actorRole === 'USER') && botTurnsRunning.has(threadId)) {
        throw new ConflictError('CHAT_BOT_REPLYING');
    }

    try {
        // saves the original message first
        const result = await createChatMessage({
            actorId,
            actorRole,
            threadId,
            content,
            normalizedContent,
        });

        // skips bot for admins, admin threads, closed threads, and non-customer senders; a
        // message written at the very moment of another one of the chat gets no turn of its own,
        // the bot answers the other
        const botTurn =
            shouldTriggerBotTurn(result.message.senderType, result.thread) &&
            !botTurnsRunning.has(threadId);
        if (botTurn) botTurnsRunning.add(threadId);

        try {
            onSaved?.(result);
            if (!botTurn) return result;

            // creates bot response after message save
            return await attachBotTurn({
                actorId,
                actorRole,
                threadId,
                content,
                normalizedContent,
                result,
                log,
            });
        } finally {
            if (botTurn) botTurnsRunning.delete(threadId);
        }
    } catch (err) {
        // preserves known application errors
        if (isAppError(err)) throw err;

        // maps retryable transaction errors to stable resource-busy response
        if (isRetryableTxError(err)) {
            throw new ResourceBusyError();
        }

        // wraps unexpected send-message failures
        throw new InternalError({ reason: 'CHAT_MESSAGE_SEND_UNEXPECTED' }, err);
    }
}
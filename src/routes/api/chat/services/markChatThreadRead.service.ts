import { ChatMessageSenderType, Prisma } from '@prisma/client';

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

import type { ChatThreadItemDto } from 'types/dto/chats.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

interface MarkChatThreadReadDto {
    actorId: UserId;
    actorRole: Role;
    threadId: string;
}

interface MarkChatThreadReadResponseDto {
    thread: ChatThreadItemDto;
}

interface LockedChatThreadDto {
    id: string;
    userId: number | null;
    guestId: string | null;
    type: 'bot' | 'admin';
    status: 'open' | 'closed';
}

// normalize user id
function toUserId(actorId: string | number): number {
    const id = typeof actorId === 'number' ? actorId : Number(actorId);

    if (!Number.isInteger(id) || id <= 0) {
        throw new BadRequestError('USER_ID_INVALID');
    }

    return id;
}

export async function markChatThreadReadService({
    actorId,
    actorRole,
    threadId,
}: MarkChatThreadReadDto): Promise<MarkChatThreadReadResponseDto> {
    try {
        return await tx(
            async (db) => {
                // prepare transaction context
                await setActorContext(db, {
                    actorId,
                    role: actorRole,
                });

                await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

                // lock target thread
                const lockedThreads = await db.$queryRaw<LockedChatThreadDto[]>`
                    SELECT id, "userId", "guestId", type, status
                    FROM cartlify.chat_threads
                    WHERE id = ${threadId}::uuid
                    FOR UPDATE
                `;

                const lockedThread = lockedThreads[0];

                if (!lockedThread) {
                    throw new NotFoundError('CHAT_THREAD_NOT_FOUND');
                }

                if (lockedThread.status === 'closed') {
                    throw new ConflictError('CHAT_THREAD_CLOSED');
                }

                let senderTypesToRead: ChatMessageSenderType[];
                let shouldClearAdminUnreadState = false;

                // admin reads customer messages
                if (actorRole === 'ADMIN' || actorRole === 'ROOT') {
                    if (lockedThread.type !== 'admin') {
                        throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
                    }

                    senderTypesToRead = [
                        ChatMessageSenderType.user,
                        ChatMessageSenderType.guest,
                    ];

                    shouldClearAdminUnreadState = true;
                }

                // user reads bot/admin messages in own thread
                else if (actorRole === 'USER') {
                    if (lockedThread.userId !== toUserId(actorId)) {
                        throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
                    }

                    senderTypesToRead = [
                        ChatMessageSenderType.bot,
                        ChatMessageSenderType.admin,
                    ];
                }

                // guest reads only bot messages in own bot thread
                else if (actorRole === 'GUEST') {
                    if (lockedThread.guestId !== String(actorId)) {
                        throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
                    }

                    if (lockedThread.type !== 'bot') {
                        throw new ForbiddenError('CHAT_GUEST_ADMIN_FORBIDDEN');
                    }

                    senderTypesToRead = [ChatMessageSenderType.bot];
                }

                // block unknown roles
                else {
                    throw new ForbiddenError('CHAT_MARK_READ_FORBIDDEN');
                }

                // mark visible incoming messages as read
                await db.chatMessage.updateMany({
                    where: {
                        threadId,
                        senderType: {
                            in: senderTypesToRead,
                        },
                        isRead: false,
                    },
                    data: {
                        isRead: true,
                    },
                });

                // move requested admin thread to active queue when admin reads it
                if (shouldClearAdminUnreadState) {
                    const thread = await db.chatThread.update({
                        where: {
                            id: threadId,
                        },
                        data: {
                            unreadCount: 0,
                            adminRequestedAt: null,
                        },
                    });

                    return {
                        thread,
                    };
                }

                // return unchanged thread for customer read state
                const thread = await db.chatThread.findUnique({
                    where: {
                        id: threadId,
                    },
                });

                if (!thread) {
                    throw new NotFoundError('CHAT_THREAD_NOT_FOUND');
                }

                return {
                    thread,
                };
            },
            {
                maxRetries: 3,
                isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
                maxWait: 1500,
                timeout: 10_000,
            },
        );
    } catch (err) {
        if (isAppError(err)) throw err;

        if (isRetryableTxError(err)) {
            throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
        }

        throw new InternalError({ reason: 'CHAT_MARK_READ_UNEXPECTED' }, err);
    }
}
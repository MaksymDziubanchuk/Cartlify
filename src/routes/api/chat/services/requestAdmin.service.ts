import { Prisma } from '@prisma/client';

import { isRetryableTxError, tx } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import {
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

interface RequestAdminDto {
    actorId: UserId;
    actorRole: Role;
    threadId: string;
}

interface RequestAdminResponseDto {
    thread: ChatThreadItemDto;
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

export async function requestAdminService({
    actorId,
    actorRole,
    threadId,
}: RequestAdminDto): Promise<RequestAdminResponseDto> {
    // check customer access
    if (actorRole !== 'USER') {
        throw new ForbiddenError('CHAT_REQUEST_ADMIN_FORBIDDEN');
    }

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
                    SELECT id, "userId", "guestId", type, status, "adminRequestedAt", "adminUnreadSince"
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

                // check user ownership
                if (actorRole === 'USER' && lockedThread.userId !== Number(actorId)) {
                    throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
                }

                // return existing admin thread
                if (lockedThread.type === 'admin') {
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
                }

                // switch thread to admin pending state
                const thread = await db.chatThread.update({
                    where: {
                        id: threadId,
                    },
                    data: {
                        type: 'admin',
                        adminRequestedAt: new Date(),
                    },
                });

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

        throw new InternalError({ reason: 'CHAT_REQUEST_ADMIN_UNEXPECTED' }, err);
    }
}
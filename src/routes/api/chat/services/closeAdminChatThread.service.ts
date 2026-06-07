import { Prisma } from '@prisma/client';

import { tx, isRetryableTxError } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import {
    ConflictError,
    ForbiddenError,
    InternalError,
    isAppError,
    NotFoundError,
    ResourceBusyError,
} from '@utils/errors.js';

import type {
    CloseChatThreadDto,
    CloseChatThreadResponseDto,
} from 'types/dto/chats.dto.js';

export async function closeAdminChatThreadService({
    actorId,
    actorRole,
    threadId,
}: CloseChatThreadDto): Promise<CloseChatThreadResponseDto> {
    if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') {
        throw new ForbiddenError('CHAT_ADMIN_FORBIDDEN');
    }

    try {
        return await tx(
            async (db) => {
                // set rls session context
                await setActorContext(db, { actorId, role: actorRole });

                // bound lock wait
                await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

                // lock thread row before closing
                const lockedThreads = await db.$queryRaw<
                    { id: string; type: 'bot' | 'admin'; status: 'open' | 'closed' }[]
                >`
                    SELECT id, type, status
                    FROM cartlify.chat_threads
                    WHERE id = ${threadId}::uuid
                    FOR UPDATE
                `;
                const lockedThread = lockedThreads[0];

                if (!lockedThread) {
                    throw new NotFoundError('CHAT_THREAD_NOT_FOUND');
                }

                if (lockedThread.status === 'closed') {
                    throw new ConflictError('CHAT_THREAD_ALREADY_CLOSED');
                }

                if (lockedThread.type !== 'admin') {
                    throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
                }

                const thread = await db.chatThread.update({
                    where: {
                        id: threadId,
                    },
                    data: {
                        status: 'closed',
                        unreadCount: 0,
                        adminRequestedAt: null,
                        adminUnreadSince: null,
                    },
                });

                return {
                    thread,
                };
            },
            {
                // keep default isolation and retry only transient lock/conflict errors
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

        throw new InternalError({ reason: 'CHAT_THREAD_CLOSE_UNEXPECTED' }, err);
    }
}
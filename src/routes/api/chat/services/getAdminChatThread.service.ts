import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import {
    ForbiddenError,
    InternalError,
    isAppError,
    NotFoundError,
} from '@utils/errors.js';

import type {
    AdminChatThreadResponseDto,
    FindAdminChatThreadDto,
} from 'types/dto/chats.dto.js';

export async function getAdminChatThreadService({
    actorId,
    actorRole,
    threadId,
}: FindAdminChatThreadDto): Promise<AdminChatThreadResponseDto> {
    // check admin access
    if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') {
        throw new ForbiddenError('CHAT_ADMIN_FORBIDDEN');
    }

    try {
        return await prisma.$transaction(async (tx) => {
            // set rls session context
            await setActorContext(tx, {
                actorId,
                role: actorRole,
            });

            // find target thread
            const thread = await tx.chatThread.findUnique({
                where: {
                    id: threadId,
                },
            });

            if (!thread) {
                throw new NotFoundError('CHAT_THREAD_NOT_FOUND');
            }

            if (thread.type !== 'admin') {
                throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
            }

            // build owner filter for previous closed threads
            const ownerFilter =
                thread.userId !== null
                    ? { userId: thread.userId }
                    : thread.guestId !== null
                        ? { guestId: thread.guestId }
                        : null;

            // load previous closed threads for same customer
            const previousThreads = ownerFilter
                ? await tx.chatThread.findMany({
                    where: {
                        id: {
                            not: threadId,
                        },
                        type: 'admin',
                        status: 'closed',
                        ...ownerFilter,
                    },
                    orderBy: {
                        lastMessageAt: 'desc',
                    },
                })
                : [];

            // mark unread customer messages when admin opens active thread
            if (thread.status === 'open') {
                await tx.chatMessage.updateMany({
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

                const updatedThread = await tx.chatThread.update({
                    where: {
                        id: threadId,
                    },
                    data: {
                        unreadCount: 0,
                        adminRequestedAt: null,
                    },
                });

                const messages = await tx.chatMessage.findMany({
                    where: {
                        threadId,
                    },
                    orderBy: {
                        createdAt: 'asc',
                    },
                });

                return {
                    thread: updatedThread,
                    messages,
                    previousThreads,
                };
            }

            // load closed thread history
            const messages = await tx.chatMessage.findMany({
                where: {
                    threadId,
                },
                orderBy: {
                    createdAt: 'asc',
                },
            });

            return {
                thread,
                messages,
                previousThreads,
            };
        });
    } catch (err) {
        if (isAppError(err)) throw err;

        throw new InternalError({ reason: 'CHAT_ADMIN_THREAD_GET_UNEXPECTED' }, err);
    }
}
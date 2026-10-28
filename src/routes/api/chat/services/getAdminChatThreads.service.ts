import { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import { assertLimit } from '@helpers/assertLimit.js';
import {
    BadRequestError,
    ForbiddenError,
    InternalError,
    isAppError,
} from '@utils/errors.js';

import type {
    AdminChatThreadsResponseDto,
    FindAdminChatThreadsDto,
} from 'types/dto/chats.dto.js';

// validate page
function assertPage(page: unknown): number {
    const n = typeof page === 'number' ? page : Number(page);

    if (!Number.isInteger(n) || n < 1) {
        throw new BadRequestError('PAGE_INVALID');
    }

    return n;
}

export async function getAdminChatThreadsService(
    dto: FindAdminChatThreadsDto,
): Promise<AdminChatThreadsResponseDto> {
    // check admin access
    if (dto.actorRole !== 'ADMIN' && dto.actorRole !== 'ROOT') {
        throw new ForbiddenError('CHAT_ADMIN_FORBIDDEN');
    }

    // normalize pagination
    const page = assertPage(dto.page);
    const limit = assertLimit(dto.limit);

    // build queue filters: waiting is a chat the customer asked an admin for and wrote in, active is
    // every chat an admin took, unread is any chat with a message no admin has read
    const where: Prisma.ChatThreadWhereInput = {
        status: 'open',
        type: 'admin',
        ...(dto.queue === 'waiting'
            ? { adminRequestedAt: { not: null }, adminUnreadSince: { not: null } }
            : dto.queue === 'active'
                ? { adminRequestedAt: null }
                : { adminUnreadSince: { not: null } }),
    };

    // build queue order: waiting puts the longest request first, unread the message unread longest,
    // active the newest chat
    const orderBy: Prisma.ChatThreadOrderByWithRelationInput[] =
        dto.queue === 'unread'
            ? [
                {
                    adminUnreadSince: 'asc',
                },
                {
                    id: 'asc',
                },
            ]
            : dto.queue === 'waiting'
            ? [
                {
                    adminRequestedAt: {
                        sort: 'asc',
                        nulls: 'last',
                    },
                },
                {
                    lastMessageAt: 'desc',
                },
            ]
            : [
                {
                    lastMessageAt: 'desc',
                },
                {
                    id: 'asc',
                },
            ];

    try {
        return await prisma.$transaction(async (tx) => {
            // set rls session context
            await setActorContext(tx, {
                actorId: dto.actorId,
                role: dto.actorRole,
            });

            // load admin queue threads, then count matching threads: one after the other, the
            // transaction has one connection, and it runs one statement at a time
            const items = await tx.chatThread.findMany({
                where,
                orderBy,
                skip: (page - 1) * limit,
                take: limit,
            });
            const total = await tx.chatThread.count({
                where,
            });

            // return paginated list
            return {
                items,
                page,
                limit,
                total,
            };
        });
    } catch (err) {
        if (isAppError(err)) throw err;

        throw new InternalError({ reason: 'CHAT_ADMIN_THREADS_UNEXPECTED' }, err);
    }
}
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

    // build queue filters
    const where: Prisma.ChatThreadWhereInput =
        dto.queue === 'waiting'
            ? {
                status: 'open',
                type: 'admin',
                adminUnreadSince: {
                    not: null,
                },
            }
            : {
                status: 'open',
                type: 'admin',
                adminRequestedAt: null,
                adminUnreadSince: null,
            };

    // build queue order
    const orderBy: Prisma.ChatThreadOrderByWithRelationInput[] =
        dto.queue === 'waiting'
            ? [
                {
                    adminUnreadSince: {
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
            ];

    try {
        return await prisma.$transaction(async (tx) => {
            // set rls session context
            await setActorContext(tx, {
                actorId: dto.actorId,
                role: dto.actorRole,
            });

            // load admin queue threads
            const [items, total] = await Promise.all([
                tx.chatThread.findMany({
                    where,
                    orderBy,
                    skip: (page - 1) * limit,
                    take: limit,
                }),

                // count matching threads
                tx.chatThread.count({
                    where,
                }),
            ]);

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
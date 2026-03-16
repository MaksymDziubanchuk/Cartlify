import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { InternalError, isAppError } from '@utils/errors.js';
import { mapOrderRowToResponse } from './helpers/index.js';

import {
  normalizeFindOrdersInput,
  buildOrdersWhere,
  buildOrdersCursorWhere,
  buildOrdersOrderBy,
  makeNextOrdersCursor,
} from './helpers/index.js';

import type { FindOrdersDto, GetOrdersResponseDto } from 'types/dto/orders.dto.js';

export async function findOrders(dto: FindOrdersDto): Promise<GetOrdersResponseDto> {
  const { actorId, actorRole, limit, cursor, status, confirmed, sortBy, sortDir } =
    normalizeFindOrdersInput(dto);

  const baseWhere = buildOrdersWhere({ actorId, actorRole, status, confirmed, sortBy });
  const cursorWhere = buildOrdersCursorWhere({ sortBy, sortDir, cursor });

  const where = cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere;
  const orderBy = buildOrdersOrderBy(sortBy, sortDir);

  try {
    return await prisma.$transaction(async (tx) => {
      // set rls session context
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const rows = await tx.order.findMany({
        where,
        orderBy,
        take: limit + 1,
        select: {
          id: true,
          userId: true,
          status: true,
          confirmed: true,
          total: true,
          shippingAddress: true,
          note: true,
          createdAt: true,
          updatedAt: true,
          items: {
            select: {
              productId: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
              product: {
                select: {
                  id: true,
                  name: true,
                  categoryId: true,
                  stock: true,
                  reservedStock: true,
                  deletedAt: true,
                  images: {
                    select: { url: true, position: true, isPrimary: true },
                    orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
                    take: 1,
                  },
                },
              },
            },
            orderBy: { id: 'asc' },
          },
        },
      });

      const total = await tx.order.count({ where: baseWhere });

      const hasNext = rows.length > limit;
      const pageRows = hasNext ? rows.slice(0, limit) : rows;

      const nextCursor =
        hasNext && pageRows.length
          ? makeNextOrdersCursor(sortBy, pageRows[pageRows.length - 1])
          : null;

      return {
        items: pageRows.map(mapOrderRowToResponse),
        limit,
        nextCursor,
        total,
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'ORDERS_LIST_UNEXPECTED' }, err);
  }
}

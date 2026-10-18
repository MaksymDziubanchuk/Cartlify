import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { InternalError, isAppError } from '@utils/errors.js';

import {
  freshenUnconfirmedOrders,
  mapOrderRowToResponse,
  orderResponseSelect,
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

      // unconfirmed orders of the user show current prices and no deleted products, paid ones
      // keep the prices they were paid with: a confirmed order never changes its items
      if (actorRole === 'USER') await freshenUnconfirmedOrders(tx, Number(actorId));

      const rows = await tx.order.findMany({
        where,
        orderBy,
        take: limit + 1,
        select: orderResponseSelect,
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

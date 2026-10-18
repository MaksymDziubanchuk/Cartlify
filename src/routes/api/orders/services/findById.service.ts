import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { InternalError, NotFoundError, ResourceBusyError, isAppError } from '@utils/errors.js';
import {
  dropDeletedProductItems,
  mapOrderRowToResponse,
  orderResponseSelect,
} from './helpers/index.js';

import type { FindOrderByIdDto, OrderResponseDto } from 'types/dto/orders.dto.js';

export async function findById({
  actorId,
  actorRole,
  orderId,
}: FindOrderByIdDto): Promise<OrderResponseDto> {
  try {
    return await tx(
      async (db) => {
        // set rls session context
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // bring item prices of an own unconfirmed order to current product prices
        // an order that lost its reservation is no longer the current cart, so this is where its prices get fresh,
        // and where it loses the items of products deleted from the catalog
        // rls lets the owner touch only own unconfirmed orders, for any other order nothing changes
        if (actorRole === 'USER') {
          await dropDeletedProductItems(db, Number(actorId), [Number(orderId)]);
          await db.$executeRaw`select cartlify.refresh_order_prices(${Number(orderId)}::int)`;
        }

        const order = await db.order.findUnique({
          where: { id: Number(orderId) },
          select: orderResponseSelect,
        });

        // if rls denies access, it will look like "not found"
        if (!order) throw new NotFoundError('ORDER_NOT_FOUND', { orderId });

        return mapOrderRowToResponse(order);
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

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) {
      throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
    }

    throw new InternalError({ reason: 'ORDERS_GET_BY_ID_UNEXPECTED' }, err);
  }
}

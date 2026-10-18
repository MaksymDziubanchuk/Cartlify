import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  ConflictError,
  ForbiddenError,
  BadRequestError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import { mapOrderRowToResponse, orderResponseSelect } from './helpers/index.js';

import type { UpdateOrderStatusDto, OrderResponseDto, OrderStatus } from 'types/dto/orders.dto.js';

// the statuses an order may come from, the same rule the database policy holds:
// a paid order is shipped, a paid or shipped one is delivered
const ALLOWED_FROM: Record<string, OrderStatus[]> = {
  shipped: ['paid'],
  delivered: ['paid', 'shipped'],
};

export async function updateOrderStatus({
  actorId,
  actorRole,
  orderId,
  status,
}: UpdateOrderStatusDto): Promise<OrderResponseDto> {
  // enforce admin/root only
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  // a cancel returns the money and the stock, it goes through POST /:orderId/cancel
  if (!['shipped', 'delivered'].includes(status)) throw new BadRequestError('STATUS_INVALID');

  const orderIdRaw = Number(orderId);

  try {
    return await tx(
      async (db) => {
        // set rls session context
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // an admin sees every order: a missing one is not found, an order whose status does not
        // allow the step is a conflict with the reason, never "not found"
        const current = await db.order.findUnique({
          where: { id: orderIdRaw },
          select: { status: true },
        });
        if (!current) throw new NotFoundError('ORDER_NOT_FOUND', { orderId: orderIdRaw });

        if (!ALLOWED_FROM[status]?.includes(current.status)) {
          throw new ConflictError('ORDER_STATUS_TRANSITION_INVALID', {
            status: current.status,
            requested: status,
          });
        }

        // rls holds the same rule: an order changed by another request meanwhile is hidden from
        // the update, it was there a moment ago, so it is a conflict too
        try {
          await db.order.update({
            where: { id: orderIdRaw },
            data: { status },
            select: { id: true },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
            throw new ConflictError('ORDER_STATUS_CHANGED', { orderId: orderIdRaw });
          }
          throw err;
        }

        const order = await db.order.findUnique({
          where: { id: orderIdRaw },
          select: orderResponseSelect,
        });

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_STATUS_UPDATE' });

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

    if (isRetryableTxError(err)) {
      throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
    }

    throw new InternalError({ reason: 'ORDERS_UPDATE_STATUS_UNEXPECTED' }, err);
  }
}

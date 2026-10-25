import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import {
  ConflictError,
  ForbiddenError,
  BadRequestError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import { mapOrderRowToResponse, expiredOfOrders, orderResponseSelect } from './helpers/index.js';
import {
  sendOrderStatusEmail,
  type OrderStatusMailLogger,
  type ShippingStatus,
} from './helpers/sendOrderStatusEmail.helper.js';

import type { UpdateOrderStatusDto, OrderResponseDto, OrderStatus } from 'types/dto/orders.dto.js';

// the statuses an order may come from, the same rule the database policy holds:
// a paid order is shipped, a paid or shipped one is delivered
const ALLOWED_FROM: Record<ShippingStatus, OrderStatus[]> = {
  shipped: ['paid'],
  delivered: ['paid', 'shipped'],
};

const isShippingStatus = (status: OrderStatus): status is ShippingStatus =>
  Object.hasOwn(ALLOWED_FROM, status);

// a shipped or delivered order mails the buyer after the commit, unless the account is deleted.
// The step goes to the admin log in the name of the admin; a second request of the same step (a
// double click) finds the order moved on and is 409 with no second mail
export async function updateOrderStatus(
  { actorId, actorRole, orderId, status }: UpdateOrderStatusDto,
  log: OrderStatusMailLogger,
): Promise<OrderResponseDto> {
  // enforce admin/root only
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  // a cancel returns the money and the stock, it goes through POST /:orderId/cancel
  if (!isShippingStatus(status)) throw new BadRequestError('STATUS_INVALID');

  const orderIdRaw = Number(orderId);

  try {
    const result = await tx(
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

        if (!ALLOWED_FROM[status].includes(current.status)) {
          throw new ConflictError('ORDER_STATUS_TRANSITION_INVALID', {
            status: current.status,
            requested: status,
          });
        }

        // the step only from the status it was read in: a request that read the order before
        // another one moved it changes nothing (the update waits for the row, then finds the new
        // status); rls holds the same rule
        const moved = await db.order.updateMany({
          where: { id: orderIdRaw, status: current.status },
          data: { status },
        });
        if (moved.count !== 1) {
          throw new ConflictError('ORDER_STATUS_CHANGED', { orderId: orderIdRaw });
        }

        await writeAdminAuditLog(db, {
          actorId,
          actorRole,
          entityType: 'order',
          entityId: orderIdRaw,
          action: 'ORDER_STATUS_CHANGE',
          changes: [{ field: 'status', old: current.status, new: status }],
        });

        const order = await db.order.findUnique({
          where: { id: orderIdRaw },
          select: orderResponseSelect,
        });

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_STATUS_UPDATE' });

        return mapOrderRowToResponse(order, await expiredOfOrders(db, [order]));
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );

    // the status is committed; the mail never undoes it, a failure is only logged
    await sendOrderStatusEmail(orderIdRaw, status, log);

    return result;
  } catch (err) {
    if (isAppError(err)) throw err;

    if (isRetryableTxError(err)) {
      throw new ResourceBusyError();
    }

    throw new InternalError({ reason: 'ORDERS_UPDATE_STATUS_UNEXPECTED' }, err);
  }
}

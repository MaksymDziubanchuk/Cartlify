import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  ForbiddenError,
  InternalError,
  NotFoundError,
  isAppError,
  ResourceBusyError,
} from '@utils/errors.js';
import { mapOrderRowToResponse } from './helpers/index.js';

import type { CurrentDeleteItemDto, OrderResponseDto } from 'types/dto/orders.dto.js';

export async function deleteCurrentItem({
  actorId,
  actorRole,
  itemId,
}: CurrentDeleteItemDto): Promise<OrderResponseDto> {
  // enforce user-only cart writes
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  const itemIdRaw = Number(itemId);
  const actorIdRaw = Number(actorId);

  try {
    return await tx(
      async (db) => {
        // set rls session context
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // lock item row and ensure it belongs to actor open order; keep orderId before delete
        const locked = await db.$queryRaw<{ order_id: number }[]>`
          SELECT oi."orderId" AS order_id
          FROM cartlify.order_items oi
          JOIN cartlify.orders o ON o.id = oi."orderId"
          WHERE oi.id = ${itemIdRaw}
            AND o."userId" = ${actorIdRaw}
            AND o.confirmed = false
            AND o.status = 'pending'
          FOR UPDATE OF oi
        `;
        if (!locked.length) throw new NotFoundError('ORDER_ITEM_NOT_FOUND', { itemId: itemIdRaw });

        const orderId = locked[0]!.order_id;

        // delete item (totals are maintained by db triggers)
        await db.orderItem.delete({
          where: { id: itemIdRaw },
          select: { id: true },
        });

        // bring remaining items to current product prices
        // confirm refuses an order with outdated prices, so the cart must show what will be confirmed
        await db.$executeRaw`select cartlify.refresh_order_prices(${orderId}::int)`;

        // fetch current order after delete
        const order = await db.order.findUnique({
          where: { id: orderId },
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
                id: true,
                productId: true,
                quantity: true,
                unitPrice: true,
                totalPrice: true,

                // include minimal product snapshot for order ui
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

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_DELETE' });

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
    throw new InternalError({ reason: 'ORDERS_CURRENT_DELETE_ITEM_UNEXPECTED' }, err);
  }
}

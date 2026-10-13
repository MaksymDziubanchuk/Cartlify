import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  ForbiddenError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import { mapOrderRowToResponse } from './helpers/index.js';

import type { GetCurrentOrderDto, OrderResponseDto } from 'types/dto/orders.dto.js';

export async function getCurrent({
  actorId,
  actorRole,
}: GetCurrentOrderDto): Promise<OrderResponseDto> {
  // enforce user-only cart reads
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  try {
    return await tx(
      async (db) => {
        // set rls session context
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // find current open order
        const current = await db.order.findFirst({
          where: { userId: actorId as any, confirmed: false, status: 'pending' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });

        if (!current) throw new NotFoundError('CURRENT_ORDER_NOT_FOUND');

        // bring item prices to current product prices, totals are maintained by db triggers
        // confirm refuses an order with outdated prices, so the cart must show what will be confirmed
        await db.$executeRaw`select cartlify.refresh_order_prices(${current.id}::int)`;

        const order = await db.order.findUnique({
          where: { id: current.id },
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

        if (!order) throw new NotFoundError('CURRENT_ORDER_NOT_FOUND');

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

    throw new InternalError({ reason: 'ORDERS_CURRENT_GET_UNEXPECTED' }, err);
  }
}

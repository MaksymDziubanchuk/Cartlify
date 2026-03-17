import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import { mapOrderRowToResponse } from './helpers/index.js';
import { scheduleOrderReservationExpiry } from './helpers/index.js';

import type { ConfirmCurrentOrderDto, OrderResponseDto } from 'types/dto/orders.dto.js';

const DEFAULT_RESERVE_FOR = '15 minutes';

export async function confirmOrder({
  actorId,
  actorRole,
  orderId,
}: ConfirmCurrentOrderDto): Promise<OrderResponseDto> {
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  try {
    const result = await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // confirm in db
        await db.$executeRaw`select cartlify.confirm_order(
          ${Number(orderId)}::int,
          ${DEFAULT_RESERVE_FOR}::interval
        )`;

        const order = await db.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            userId: true,
            status: true,
            confirmed: true,
            reservationExpiresAt: true,
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

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_CONFIRM' });

        return {
          response: mapOrderRowToResponse(order),
          reservationExpiresAt: order.reservationExpiresAt,
        };
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );
    await scheduleOrderReservationExpiry(result.response.id, result.reservationExpiresAt);

    return result.response;
  } catch (err) {
    if (isAppError(err)) throw err;

    if (isRetryableTxError(err)) {
      throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
    }

    // db function errors come as P2010
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
      const msg = String((err.meta as any)?.message ?? err.message);

      if (msg.includes('ORDER_NOT_FOUND')) throw new NotFoundError('ORDER_NOT_FOUND');
      if (msg.includes('ORDER_CONFIRM_FORBIDDEN'))
        throw new ForbiddenError('ORDER_CONFIRM_FORBIDDEN');
      if (msg.includes('ORDER_ALREADY_CONFIRMED'))
        throw new ConflictError('ORDER_ALREADY_CONFIRMED');
      if (msg.includes('ORDER_STATUS_NOT_ALLOWED'))
        throw new ConflictError('ORDER_STATUS_NOT_ALLOWED');
      if (msg.includes('ORDER_ITEMS_REQUIRED')) throw new BadRequestError('ORDER_ITEMS_REQUIRED');
      if (msg.includes('INSUFFICIENT_AVAILABLE_STOCK'))
        throw new ConflictError('INSUFFICIENT_AVAILABLE_STOCK');
      if (msg.includes('PRODUCT_NOT_FOUND')) throw new NotFoundError('PRODUCT_NOT_FOUND');
      if (msg.includes('ORDER_RESERVATION_DURATION_INVALID'))
        throw new BadRequestError('ORDER_RESERVATION_DURATION_INVALID');
    }

    throw new InternalError({ reason: 'ORDERS_CURRENT_CONFIRM_UNEXPECTED' }, err);
  }
}

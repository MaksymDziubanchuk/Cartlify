import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  ForbiddenError,
  BadRequestError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import { mapOrderRowToResponse } from './helpers/index.js';

import type { UpdateOrderStatusDto, OrderResponseDto } from 'types/dto/orders.dto.js';

export async function updateOrderStatus({
  actorId,
  actorRole,
  orderId,
  status,
}: UpdateOrderStatusDto): Promise<OrderResponseDto> {
  // enforce admin/root only
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  if (!['shipped', 'delivered', 'cancelled'].includes(status))
    throw new BadRequestError('STATUS_INVALID');

  const orderIdRaw = Number(orderId);

  try {
    return await tx(
      async (db) => {
        // set rls session context
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // rls enforces allowed transitions; if not allowed, update will behave like "not found"
        try {
          await db.order.update({
            where: { id: orderIdRaw },
            data: { status },
            select: { id: true },
          });
        } catch (err) {
          // p2025: record not found (also happens when rls USING filters the row out)
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
            throw new NotFoundError('ORDER_NOT_FOUND', { orderId: orderIdRaw });
          }
          throw err;
        }

        const order = await db.order.findUnique({
          where: { id: orderIdRaw },
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

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_STATUS_UPDATE' });

        return mapOrderRowToResponse(order as any);
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

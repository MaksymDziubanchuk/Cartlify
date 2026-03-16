import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { InternalError, NotFoundError, isAppError } from '@utils/errors.js';
import { mapOrderRowToResponse } from './helpers/index.js';

import type { FindOrderByIdDto, OrderResponseDto } from 'types/dto/orders.dto.js';

export async function findById({
  actorId,
  actorRole,
  orderId,
}: FindOrderByIdDto): Promise<OrderResponseDto> {
  try {
    return await prisma.$transaction(async (tx) => {
      // set rls session context
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const order = await tx.order.findUnique({
        where: { id: Number(orderId) },
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

      // if rls denies access, it will look like "not found"
      if (!order) throw new NotFoundError('ORDER_NOT_FOUND', { orderId });

      return mapOrderRowToResponse(order);
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'ORDERS_GET_BY_ID_UNEXPECTED' }, err);
  }
}

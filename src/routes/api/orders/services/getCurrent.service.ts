import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  ForbiddenError,
  InternalError,
  NotFoundError,
  isAppError,
  ResourceBusyError,
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
    return await prisma.$transaction(async (tx) => {
      // set rls session context
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const order = await tx.order.findFirst({
        where: { userId: actorId as any, confirmed: false, status: 'pending' },
        orderBy: { createdAt: 'desc' },
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
            select: { productId: true, quantity: true, unitPrice: true, totalPrice: true },
            orderBy: { id: 'asc' },
          },
        },
      });

      if (!order) throw new NotFoundError('CURRENT_ORDER_NOT_FOUND');

      return mapOrderRowToResponse(order as any);
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'ORDERS_CURRENT_GET_UNEXPECTED' }, err);
  }
}

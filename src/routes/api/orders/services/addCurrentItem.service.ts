import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  isAppError,
  ResourceBusyError,
} from '@utils/errors.js';
import { mapOrderRowToResponse } from './helpers/index.js';

import type { CurrentAddItemDto, OrderResponseDto } from 'types/dto/orders.dto.js';

export async function addCurrentItem({
  actorId,
  actorRole,
  productId,
  quantity,
}: CurrentAddItemDto): Promise<OrderResponseDto> {
  // enforce user-only cart writes
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  try {
    return await tx(
      async (db) => {
        // set rls session context
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // load or create current open order
        const existingOrder = await db.order.findFirst({
          where: { userId: actorId as any, confirmed: false, status: 'pending' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });

        const orderId = existingOrder
          ? existingOrder.id
          : (
              await db.order.create({
                data: {
                  userId: actorId as any,
                  total: new Prisma.Decimal(0),
                  confirmed: false,
                  status: 'pending',
                },
                select: { id: true },
              })
            ).id;

        // load product price and availability
        const product = await db.product.findFirst({
          where: { id: productId as any, deletedAt: null },
          select: { id: true, price: true, stock: true, reservedStock: true },
        });

        if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND', { productId });

        // check availability (real stock = stock - reservedStock)
        const available = product.stock - product.reservedStock;

        // upsert item in open order
        const existingItem = await db.orderItem.findFirst({
          where: { orderId, productId: productId as any },
          select: { id: true, quantity: true },
        });

        const nextQty = (existingItem?.quantity ?? 0) + quantity;
        if (nextQty > available) {
          throw new ConflictError('OUT_OF_STOCK', { productId, available, requested: nextQty });
        }

        // always store latest product price
        const unitPrice = product.price;

        if (existingItem) {
          await db.orderItem.update({
            where: { id: existingItem.id },
            data: { quantity: nextQty, unitPrice: unitPrice as any },
            select: { id: true },
          });
        } else {
          // totalPrice is required by prisma model; db trigger overwrites it
          await db.orderItem.create({
            data: {
              orderId,
              productId: productId as any,
              quantity: nextQty,
              unitPrice: unitPrice as any,
              totalPrice: new Prisma.Decimal(0),
            },
            select: { id: true },
          });
        }

        // totals are maintained by db triggers; fetch current order
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
              select: { productId: true, quantity: true, unitPrice: true, totalPrice: true },
              orderBy: { id: 'asc' },
            },
          },
        });

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_UPDATE' });

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

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) {
      throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
    }
    throw new InternalError({ reason: 'ORDERS_CURRENT_ADD_ITEM_UNEXPECTED' }, err);
  }
}

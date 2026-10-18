import type { Prisma } from '@prisma/client';

import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { InternalError } from '@utils/errors.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';

import type { OrderResponseDto } from 'types/dto/orders.dto.js';

// what every order answer reads: the cart, the confirmation, one order, the list and the status
// change of an admin. The payment id stays internal and is not read
export const orderResponseSelect = {
  id: true,
  userId: true,
  status: true,
  confirmed: true,
  reservationExpiresAt: true,
  total: true,
  shippingAddress: true,
  recipientFirstName: true,
  recipientLastName: true,
  recipientPhone: true,
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
} satisfies Prisma.OrderSelect;

export type OrderResponseRow = Prisma.OrderGetPayload<{ select: typeof orderResponseSelect }>;

export function mapOrderRowToResponse(row: OrderResponseRow): OrderResponseDto {
  return {
    id: row.id as any,
    userId: row.userId as any,
    status: row.status,
    confirmed: row.confirmed,
    total: decimalToNumber(row.total),
    shippingAddress: row.shippingAddress ?? '',
    items: row.items.map((it) => {
      const primaryUrl = it.product.images?.[0]?.url;
      if (!primaryUrl) throw new InternalError({ reason: 'PRODUCT_PRIMARY_IMAGE_NOT_FOUND' });

      const availableStock = Math.max(0, it.product.stock - it.product.reservedStock);

      return {
        // order item id, cart item routes take it as itemId
        id: it.id,
        productId: it.productId as any,
        product: {
          id: it.product.id as any,
          name: it.product.name,
          categoryId: it.product.categoryId as any,
          images: buildImageUrls(primaryUrl, 'product'),
          availableStock,
          deletedAt: it.product.deletedAt,
        },
        quantity: it.quantity,
        unitPrice: decimalToNumber(it.unitPrice),
        totalPrice: decimalToNumber(it.totalPrice),
      };
    }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // a field the order does not have yet is left out
    ...(row.reservationExpiresAt ? { reservationExpiresAt: row.reservationExpiresAt } : {}),
    ...(row.recipientFirstName ? { recipientFirstName: row.recipientFirstName } : {}),
    ...(row.recipientLastName ? { recipientLastName: row.recipientLastName } : {}),
    ...(row.recipientPhone ? { recipientPhone: row.recipientPhone } : {}),
    ...(row.note ? { note: row.note } : {}),
  };
}

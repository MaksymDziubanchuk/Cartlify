import { decimalToNumber } from '@helpers/safeNormalizer.js';

import type { OrderResponseDto } from 'types/dto/orders.dto.js';

export function mapOrderRowToResponse(row: {
  id: number;
  userId: number;
  status: any;
  confirmed: boolean;
  total: unknown;
  shippingAddress: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{ productId: number; quantity: number; unitPrice: unknown; totalPrice: unknown }>;
}): OrderResponseDto {
  return {
    id: row.id as any,
    userId: row.userId as any,
    status: row.status,
    confirmed: row.confirmed,
    total: decimalToNumber(row.total),
    shippingAddress: row.shippingAddress ?? '',
    items: row.items.map((it) => ({
      productId: it.productId as any,
      quantity: it.quantity,
      unitPrice: decimalToNumber(it.unitPrice),
      totalPrice: decimalToNumber(it.totalPrice),
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.note ? { note: row.note } : {}),
  };
}

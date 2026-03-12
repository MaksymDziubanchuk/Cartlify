import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { InternalError } from '@utils/errors.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';

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
  items: Array<{
    productId: number;
    quantity: number;
    unitPrice: unknown;
    totalPrice: unknown;
    product: {
      id: number;
      name: string;
      categoryId: number;
      stock: number;
      reservedStock: number;
      deletedAt: Date | null;
      images: Array<{ url: string; position: number; isPrimary: boolean }>;
    };
  }>;
}): OrderResponseDto {
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
    ...(row.note ? { note: row.note } : {}),
  };
}

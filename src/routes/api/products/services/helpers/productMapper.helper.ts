import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';

import type { FullProductResponseDto } from 'types/dto/products.dto.js';

export function mapProductRowToResponse(args: {
  product: {
    id: number;
    name: string;
    description: string | null;
    price: unknown;
    stock: number;
    reservedStock: number;
    categoryId: number;
    views: number;
    popularity: number;
    avgRating: unknown;
    reviewsCount: number;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  images: Array<{ url: string; position: number }>;
}): FullProductResponseDto {
  // map db row to api dto shape
  const { product, images } = args;
  const realStosk = product.stock - product.reservedStock;

  return {
    id: product.id as any,
    name: product.name,
    ...(product.description ? { description: product.description } : {}),
    price: decimalToNumber(product.price),
    stock: realStosk,
    categoryId: product.categoryId as any,
    images: images.map((r) => buildImageUrls(r.url, 'product')),
    popularity: product.popularity,
    views: product.views,
    avgRating: decimalToNumber(product.avgRating),
    reviewsCount: product.reviewsCount,
    ...(product.deletedAt ? { deletedAt: product.deletedAt.toISOString() } : {}),
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

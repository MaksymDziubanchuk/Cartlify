import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';

import type { ProductResponseDto } from 'types/dto/products.dto.js';

export function mapProductRowToResponse(args: {
  product: {
    id: number;
    name: string;
    description: string | null;
    price: unknown;
    categoryId: number;
    views: number;
    popularity: number;
    avgRating: unknown;
    reviewsCount: number;
    createdAt: Date;
    updatedAt: Date;
  };
  primaryImageUrl?: string | null;
}): ProductResponseDto {
  // map db row to api dto shape
  const { product } = args;

  return {
    id: product.id as any,
    name: product.name,
    ...(product.description ? { description: product.description } : {}),
    price: decimalToNumber(product.price),
    categoryId: product.categoryId as any,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    ...(args.primaryImageUrl ? { images: buildImageUrls(args.primaryImageUrl, 'product') } : {}),
    popularity: product.popularity,
    views: product.views,
    avgRating: decimalToNumber(product.avgRating),
    reviewsCount: product.reviewsCount,
  };
}

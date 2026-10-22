import { saleFieldsOf } from '@helpers/productSale.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';

import type { FullProductResponseDto, ProductResponseDto } from 'types/dto/products.dto.js';
import type { Role } from 'types/user.js';

// a buyer (guest, user) sees what helps to buy a product; an admin (admin, root) sees the counters,
// the whole stock, the reserve and the override of the popularity on top
export type ProductView = 'buyer' | 'admin';

export const productViewOf = (role: Role): ProductView =>
  role === 'ADMIN' || role === 'ROOT' ? 'admin' : 'buyer';

// the fields of a product its answers show (a card, a list item, a favorite): a new field of the
// answer is added here once; categoryId is for the admin log of a change
export const productResponseSelect = {
  id: true,
  name: true,
  description: true,
  price: true,
  salePrice: true,
  saleEndsAt: true,
  stock: true,
  reservedStock: true,
  categoryId: true,
  category: { select: { id: true, name: true, slug: true } },
  views: true,
  popularity: true,
  popularityOverride: true,
  popularityOverrideUntil: true,
  avgRating: true,
  reviewsCount: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type ProductResponseRow = {
  id: number;
  name: string;
  description: string | null;
  price: unknown;
  salePrice: unknown;
  saleEndsAt: Date | null;
  stock: number;
  reservedStock: number;
  category: { id: number; name: string; slug: string };
  views: number;
  popularity: number;
  popularityOverride: number | null;
  popularityOverrideUntil: Date | null;
  avgRating: unknown;
  reviewsCount: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// what every role sees of a product, without its images
export function buyerFieldsOf(product: ProductResponseRow): Omit<ProductResponseDto, 'images'> {
  return {
    id: product.id as any,
    name: product.name,
    ...(product.description ? { description: product.description } : {}),
    price: decimalToNumber(product.price),
    // the sale next to the price while it lasts, a sale that is over is left out
    ...saleFieldsOf(product),
    // free units, never below zero, the same in a card, a list and an order
    stock: Math.max(0, product.stock - product.reservedStock),
    category: {
      id: product.category.id as any,
      name: product.category.name,
      slug: product.category.slug,
    },
    avgRating: decimalToNumber(product.avgRating),
    reviewsCount: product.reviewsCount,
    createdAt: product.createdAt.toISOString(),
  };
}

// what only an admin sees of a product: the counters, the whole stock and the reserve, and the
// fields of the row as they are, null when empty: the sale and the override of the popularity, a
// sale or an override past its end too, and the delete date
export function adminFieldsOf(
  product: ProductResponseRow,
): Pick<
  ProductResponseDto,
  | 'popularity'
  | 'views'
  | 'updatedAt'
  | 'totalStock'
  | 'reservedStock'
  | 'popularityOverride'
  | 'popularityOverrideUntil'
  | 'salePrice'
  | 'saleEndsAt'
  | 'deletedAt'
> {
  return {
    popularity: product.popularity,
    views: product.views,
    updatedAt: product.updatedAt.toISOString(),
    totalStock: product.stock,
    reservedStock: product.reservedStock,
    popularityOverride: product.popularityOverride,
    popularityOverrideUntil: product.popularityOverrideUntil
      ? product.popularityOverrideUntil.toISOString()
      : null,
    salePrice: product.salePrice === null ? null : decimalToNumber(product.salePrice),
    saleEndsAt: product.saleEndsAt ? product.saleEndsAt.toISOString() : null,
    deletedAt: product.deletedAt ? product.deletedAt.toISOString() : null,
  };
}

// the card of a product page; a buyer gets no popularity in it, the list shows it
export function mapProductRowToResponse(args: {
  product: ProductResponseRow;
  images: Array<{ url: string; position: number }>;
  view: ProductView;
}): FullProductResponseDto {
  const { product, images, view } = args;

  return {
    ...buyerFieldsOf(product),
    images: images.map((r) => buildImageUrls(r.url, 'product')),
    ...(view === 'admin' ? adminFieldsOf(product) : {}),
  };
}

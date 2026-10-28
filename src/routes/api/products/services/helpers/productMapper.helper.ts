import { freeUnits } from '@db/expiredStock.helper.js';
import { parseProductDescription } from '@helpers/productDescription.js';
import { saleFieldsOf } from '@helpers/productSale.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';

import type {
  FullProductResponseDto,
  ProductCategoryDto,
  ProductResponseDto,
} from 'types/dto/products.dto.js';
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
  sku: true,
  price: true,
  salePrice: true,
  saleEndsAt: true,
  salePriorPrice: true,
  stock: true,
  reservedStock: true,
  weightGrams: true,
  lengthMm: true,
  widthMm: true,
  heightMm: true,
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
  sku: string | null;
  price: unknown;
  salePrice: unknown;
  saleEndsAt: Date | null;
  salePriorPrice: unknown;
  stock: number;
  reservedStock: number;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  // the units of batches that are over (expiredUnitsOf): not sold, so no free units
  expiredStock: number;
  // the cost of a unit in the latest delivery of a supplier (lastUnitCostsOf), read for an admin
  lastUnitCost?: unknown;
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

// the weight and the sizes of a product, null while they are not known: the card of everybody and
// the list of an admin show them
const shippingFieldsOf = (product: ProductResponseRow) => ({
  weightGrams: product.weightGrams,
  lengthMm: product.lengthMm,
  widthMm: product.widthMm,
  heightMm: product.heightMm,
});

const descriptionTextOf = (raw: string | null) => {
  const { text } = parseProductDescription(raw);
  return text ? { description: text } : {};
};

// what every role sees of a product, without its images
export function buyerFieldsOf(product: ProductResponseRow): Omit<ProductResponseDto, 'images'> {
  return {
    id: product.id as any,
    name: product.name,
    // the text of the description, without the safety data it keeps (the card gives them)
    ...descriptionTextOf(product.description),
    sku: product.sku,
    price: decimalToNumber(product.price),
    // the sale next to the price while it lasts, a sale that is over is left out
    ...saleFieldsOf(product),
    // free units, never below zero, the same in a card, a list and an order: the stock less what
    // the waiting orders hold and what is over
    stock: freeUnits(product.stock, product.reservedStock, product.expiredStock),
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

// what only an admin sees of a product: the counters, the whole stock, the reserve and the units
// that are over, the cost of the latest delivery of a supplier, and the
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
  | 'expiredStock'
  | 'lastUnitCost'
  | 'weightGrams'
  | 'lengthMm'
  | 'widthMm'
  | 'heightMm'
  | 'popularityOverride'
  | 'popularityOverrideUntil'
  | 'salePrice'
  | 'saleEndsAt'
  | 'salePriorPrice'
  | 'deletedAt'
> {
  return {
    popularity: product.popularity,
    views: product.views,
    updatedAt: product.updatedAt.toISOString(),
    totalStock: product.stock,
    reservedStock: product.reservedStock,
    expiredStock: product.expiredStock,
    lastUnitCost: product.lastUnitCost == null ? null : decimalToNumber(product.lastUnitCost),
    ...shippingFieldsOf(product),
    popularityOverride: product.popularityOverride,
    popularityOverrideUntil: product.popularityOverrideUntil
      ? product.popularityOverrideUntil.toISOString()
      : null,
    salePrice: product.salePrice === null ? null : decimalToNumber(product.salePrice),
    saleEndsAt: product.saleEndsAt ? product.saleEndsAt.toISOString() : null,
    salePriorPrice: product.salePriorPrice == null ? null : decimalToNumber(product.salePriorPrice),
    deletedAt: product.deletedAt ? product.deletedAt.toISOString() : null,
  };
}

// the card of a product page; a buyer gets no popularity in it, the list shows it. Its category
// names the way to it from the top of the tree (readCategoryPath)
export function mapProductRowToResponse(args: {
  product: ProductResponseRow;
  images: Array<{ url: string; position: number }>;
  categoryPath: ProductCategoryDto[];
  view: ProductView;
}): FullProductResponseDto {
  const { product, images, categoryPath, view } = args;
  const fields = buyerFieldsOf(product);

  return {
    ...fields,
    ...shippingFieldsOf(product),
    category: { ...fields.category, path: categoryPath },
    images: images.map((r) => buildImageUrls(r.url, 'product')),
    // the safety and origin data an offer shows (GPSR), null for a product from before them
    safety: parseProductDescription(product.description).safety,
    ...(view === 'admin' ? adminFieldsOf(product) : {}),
  };
}

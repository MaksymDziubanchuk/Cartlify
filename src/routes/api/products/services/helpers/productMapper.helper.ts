import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';

import type {
  ProductCardDto,
  ProductCategoryDto,
  ProductResponseDto,
} from 'types/dto/products.dto.js';
import type { GalleryImageDto } from 'types/dto/variants.dto.js';
import type { Role } from 'types/user.js';
import type { ProductExtras } from './productExtras.helper.js';

// a buyer (guest, user) sees what helps to buy a product; an admin (admin, root) sees the counters
// and the override of the popularity on top. The product is the part of an answer that every
// variant of it shares: the price, the sale, the stock, the weight and the article number are the
// variant's (variant.helper.ts)
export type ProductView = 'buyer' | 'admin';

export const productViewOf = (role: Role): ProductView =>
  role === 'ADMIN' || role === 'ROOT' ? 'admin' : 'buyer';

// the fields of a product its answers show (a card, a list row, a favorite): a new field of the
// answer is added here once; categoryId is for the admin log of a change
export const productResponseSelect = {
  id: true,
  name: true,
  description: true,
  categoryId: true,
  category: { select: { id: true, name: true, slug: true } },
  // the parties and the warnings of the safety data (GPSR): the parties are read apart, by these ids
  manufacturerId: true,
  euResponsibleId: true,
  warnings: true,
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
  category: { id: number; name: string; slug: string };
  manufacturerId: number;
  euResponsibleId: number | null;
  warnings: string | null;
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

const descriptionTextOf = (text: string | null) => (text ? { description: text } : {});

// what every role sees of a product
export function buyerFieldsOf(product: ProductResponseRow): ProductResponseDto {
  return {
    id: product.id as any,
    name: product.name,
    ...descriptionTextOf(product.description),
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

// what only an admin sees of a product: the counters, the last edit, the override of the
// popularity, the delete date; the fields of the row as they are, null when empty (an override
// past its end too)
export function adminFieldsOf(
  product: ProductResponseRow,
): Pick<
  ProductResponseDto,
  | 'popularity'
  | 'views'
  | 'updatedAt'
  | 'popularityOverride'
  | 'popularityOverrideUntil'
  | 'deletedAt'
> {
  return {
    popularity: product.popularity,
    views: product.views,
    updatedAt: product.updatedAt.toISOString(),
    popularityOverride: product.popularityOverride,
    popularityOverrideUntil: product.popularityOverrideUntil
      ? product.popularityOverrideUntil.toISOString()
      : null,
    deletedAt: product.deletedAt ? product.deletedAt.toISOString() : null,
  };
}

// the product part of a row of an answer (a list, a change of a variant): what everybody sees, and
// the counters of an admin on top; a buyer gets no popularity in a card, the list adds it
export function mapProductPart(product: ProductResponseRow, view: ProductView): ProductResponseDto {
  return { ...buyerFieldsOf(product), ...(view === 'admin' ? adminFieldsOf(product) : {}) };
}

// the product part of a list row (and of a row of the favorites): what every role sees, and the
// popularity the list sorts by; an admin gets the counters, the override and the delete date too
export function mapProductListPart(
  product: ProductResponseRow,
  view: ProductView,
): ProductResponseDto {
  return {
    ...buyerFieldsOf(product),
    ...(view === 'admin' ? adminFieldsOf(product) : { popularity: product.popularity }),
  };
}

// the pictures of the gallery with the variants that show each one, for the card of an admin
export function mapGallery(
  images: ReadonlyArray<{ id: number; url: string; position: number }>,
  variantIdsOf: ReadonlyMap<number, number[]>,
): GalleryImageDto[] {
  return images.map((image) => ({
    id: image.id,
    position: image.position,
    ...buildImageUrls(image.url, 'product'),
    variantIds: variantIdsOf.get(image.id) ?? [],
  }));
}

// the product part of the card; a buyer gets no popularity in it, the list shows it. Its category
// names the way to it from the top of the tree (readCategoryPath), its parties are the ones of the
// directory and its documents (readProductExtras). An admin gets the gallery with the variants
// that show each picture
export function mapProductCard(args: {
  product: ProductResponseRow;
  categoryPath: ProductCategoryDto[];
  extras: ProductExtras;
  // read for an admin only
  gallery?: GalleryImageDto[];
  view: ProductView;
}): ProductCardDto {
  const { product, categoryPath, extras, gallery, view } = args;
  const fields = buyerFieldsOf(product);

  return {
    ...fields,
    category: { ...fields.category, path: categoryPath },
    // the safety and origin data an offer shows (GPSR)
    manufacturer: extras.manufacturer,
    euResponsible: extras.euResponsible,
    warnings: product.warnings,
    // the instructions and certificates, in the order an admin gave them
    documents: extras.documents,
    ...(view === 'admin' ? { ...adminFieldsOf(product), gallery: gallery ?? [] } : {}),
  };
}

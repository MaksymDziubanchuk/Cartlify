import type { FastifyBaseLogger } from 'fastify';
import type { ProductId, UserId } from '../ids.js';
import type { Role } from 'types/user.js';
import type {
  ProductImagesUrls,
  ProductResponseDto,
  ProductSaleDto,
  UploadedProductImage,
} from './products.dto.js';

// A variant is what a buyer chooses and buys of a product: a size, a color, a memory. The answers
// that name one never name it alone: it comes with its product ({ product, variant }), a list of
// variants of one product comes with the product once.

// a picture of the gallery that a variant shows, in its place among the pictures of the variant
export type VariantImageDto = ProductImagesUrls & {
  // the id of the picture in the gallery of the product
  id: number;
  position: number;
};

// a characteristic that tells the variants of a product apart, with the label of the value the
// variant has of it (part of the name): cartlify.variant_names (db/05) writes it
export interface VariantValueDto {
  attributeId: number;
  // the name of the characteristic
  name: string;
  // the label: a text as it is, a number with its unit, the name of a value of a list (several:
  // joined with a comma), yes or no
  value: string;
}

// what a list, a cart and a switch between variants show
export interface VariantShortDto {
  id: number;
  // the place among the variants of the product, set by an admin
  position: number;
  // the name of the product and the values that tell its variants apart
  name: string;
  // the characteristics that tell the variants of the product apart, in the order of the name
  values: VariantValueDto[];
  price: number;
  // the sale next to the price, only while it lasts (an admin always gets the three, null without)
  salePrice?: number | null;
  saleEndsAt?: string | null;
  salePriorPrice?: number | null;
  // free units: the stock less what the waiting orders hold and what is over
  stock: number;
  // the first picture of the variant; null for a variant that shows none (an admin sees such)
  image: ProductImagesUrls | null;
  // admin and root only: whether a buyer sees the variant, and when it was taken out of sale
  visible?: boolean;
  deletedAt?: string | null;
}

// a characteristic the variant has, for the card: the value as the card writes it and as it is kept
export interface VariantAttributeItemDto {
  attribute: {
    id: number;
    name: string;
    unit: string | null;
    type: 'text' | 'number' | 'boolean' | 'option' | 'options';
    isMain: boolean;
  };
  // the value for the card: a text as it is, a number with its unit, the name of the value of a
  // list (several: joined with a comma), yes or no
  value: string;
  // the value as it is kept: a text, a number, yes/no, the id of the value of a list, the ids of the
  // values of a set in the order of the list; what a form of an admin needs
  raw: string | number | boolean | number[];
  // the colour of the value of a list, when it has one (a choice of one value)
  colorCode?: string;
}

// the characteristics of a group of the directory the variant has, in the order of the card
export interface VariantAttributeGroupDto {
  group: { id: number; name: string; position: number };
  items: VariantAttributeItemDto[];
}

// the variant opened in the card, or on its own
export interface VariantFullDto extends VariantShortDto {
  // every characteristic the variant has (also the ones all the variants share), groups by their
  // place, in a group the characteristics by theirs
  attributes: VariantAttributeGroupDto[];
  sku: string | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  images: VariantImageDto[];
  // admin and root only
  barcode?: string | null;
  totalStock?: number;
  reservedStock?: number;
  expiredStock?: number;
  lastUnitCost?: number | null;
  updatedAt?: string;
}

// what the answers of a product need of a variant row, read once for all the variants of an answer
export interface VariantContext {
  // units of batches that are over, by the id of the variant (variants without are left out)
  expired: Map<number, number>;
  // the name and the values that tell the variant apart, by the id of the variant
  names: Map<number, { name: string; values: VariantValueDto[] }>;
  // the characteristics of a variant for the card, by the id of the variant (read for the variants
  // an answer gives in full only)
  attributes: Map<number, VariantAttributeGroupDto[]>;
  // the cost of the latest delivery of a supplier, by the id of the variant (an admin only)
  costs: Map<number, unknown>;
}

// a variant inside a position of a cart, an order or the favorites: the short variant and whether it
// is still for sale (a variant that is hidden stays in an order that was paid)
export type VariantOfItemDto = Omit<VariantShortDto, 'values'> & { forSale: boolean };

// the pictures of the gallery with the variants that show each one, for the card of an admin
export interface GalleryImageDto extends ProductImagesUrls {
  id: number;
  position: number;
  variantIds: number[];
}

// ---- the routes of the variants of a product (src/routes/api/products, admin and root) ----

// a picture of the gallery a variant shows, with its place among the pictures of the variant
export interface VariantImageRefDto {
  // the id of the picture in the gallery of the product
  imageId: number;
  // from 1, one place for one picture of the variant
  position: number;
}

// who asks: an admin or root
export interface VariantActorDto {
  actorId: UserId;
  actorRole: Role;
}

// a value of a characteristic for a variant: a text for a text, a number, true/false, the id of a value
// of the list for a choice of one value, the ids of values of the list for a set. In a change null
// takes the value away
export interface VariantAttributeInputDto {
  attributeId: number;
  value: string | number | boolean | number[] | null;
}

// a new variant of a product that is there: its pictures are pictures of the gallery already
export interface VariantInputBodyDto {
  price: number;
  sku?: string | null;
  barcode?: string | null;
  // the weight in grams and the packed sizes in millimetres, whole numbers; a new variant needs them
  // unless withoutShippingData says they come later (the flag is not kept)
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  withoutShippingData?: boolean;
  // at least one, no more than VARIANT_IMAGES_MAX
  images: VariantImageRefDto[];
  // the values of its characteristics
  attributes?: VariantAttributeInputDto[];
  // never taken: the stock comes with a delivery; one sent is refused
  stock?: unknown;
}

export interface CreateVariantsParamsDto {
  productId: string;
}

export interface CreateVariantsBodyDto {
  variants: VariantInputBodyDto[];
}

export interface CreateVariantsDto extends CreateVariantsBodyDto, VariantActorDto {
  productId: ProductId;
}

export interface CreateVariantsResponseDto {
  // the variants made, in the order of the request, each at the next free place of the product
  variants: VariantFullDto[];
}

export interface VariantParamsDto {
  productId: string;
  variantId: string;
}

export interface GetVariantDto {
  productId: ProductId;
  variantId: number;
  actorId: UserId;
  actorRole: Role;
}

export type GetVariantResponseDto = VariantFullDto;

// what happens to the sale of a variant whose price changes: keep it, take it off, or put a new one
// on from the new price (the old one goes first). The word goes with a price
export type VariantSaleWord = 'keep' | 'remove' | ProductSaleDto;

// a change of a variant: everything sent changes, the rest stays
export interface UpdateVariantBodyDto {
  sku?: string | null;
  barcode?: string | null;
  // the regular price, whole cents
  price?: number;
  // with a price, what happens to the sale that is on (VariantSaleWord)
  sale?: VariantSaleWord;
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  withoutShippingData?: boolean;
  // the new place among the variants of the product, from 1; the others keep a place of their own
  position?: number;
  // the pictures the variant shows, written whole
  images?: VariantImageRefDto[];
  // the values that change (null takes one away); the others stay
  attributes?: VariantAttributeInputDto[];
  stock?: unknown;
}

export interface UpdateVariantDto extends UpdateVariantBodyDto, VariantActorDto {
  productId: ProductId;
  variantId: number;
}

export interface UpdateVariantResponseDto {
  product: ProductResponseDto;
  variant: VariantFullDto;
}

// the same change for several variants of one product: the fields that fit every variant (no article
// number, barcode or place: a code is unique and a place is one variant's). Without variantIds every
// variant for sale
export interface UpdateVariantsBodyDto {
  variantIds?: number[];
  price?: number;
  sale?: VariantSaleWord;
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  withoutShippingData?: boolean;
  // the pictures every one of the variants shows, written whole (an empty list takes them away)
  images?: VariantImageRefDto[];
  // the values that change in every one of the variants (null takes one away)
  attributes?: VariantAttributeInputDto[];
  stock?: unknown;
}

export interface UpdateVariantsParamsDto {
  productId: string;
}

export interface UpdateVariantsDto extends UpdateVariantsBodyDto, VariantActorDto {
  productId: ProductId;
}

export interface UpdateVariantsResponseDto {
  // every variant the request named (or every one for sale), as an admin sees them
  variants: VariantFullDto[];
}

// a change of variants of any products, each with the fields of its own: any field of the change of
// one variant (the article number, the barcode and the place too)
export interface UpdateVariantsBatchItemDto extends UpdateVariantBodyDto {
  variantId: number;
}

export interface UpdateVariantsBatchBodyDto {
  items: UpdateVariantsBatchItemDto[];
}

export interface UpdateVariantsBatchDto extends UpdateVariantsBatchBodyDto, VariantActorDto {}

export interface UpdateVariantsBatchResponseDto {
  // in the order of the items
  items: UpdateVariantResponseDto[];
}

export interface DeleteVariantDto extends VariantActorDto {
  productId: ProductId;
  variantId: number;
}

export interface DeleteVariantResponseDto {
  id: number;
  deletedAt: string;
}

export interface RestoreVariantDto extends VariantActorDto {
  productId: ProductId;
  variantId: number;
}

export type RestoreVariantResponseDto = UpdateVariantResponseDto;

// ---- the gallery of a product ----

export interface GalleryParamsDto {
  productId: string;
}

// the first look at a gallery that is to get pictures, before the files of the request are read
export interface GalleryRoomDto extends VariantActorDto {
  productId: ProductId;
}

export interface GalleryRoomResponseDto {
  // the pictures the gallery has now
  have: number;
}

export interface UploadGalleryDto extends VariantActorDto {
  productId: ProductId;
  // the files of the request, uploaded and waiting for the product to be written
  images: UploadedProductImage[];
  log: FastifyBaseLogger;
}

export interface UploadGalleryResponseDto {
  // the whole gallery of the product after the request, the new pictures included
  images: GalleryImageDto[];
}

export interface GalleryImageParamsDto {
  productId: string;
  imageId: string;
}

export interface DeleteGalleryImageDto extends VariantActorDto {
  productId: ProductId;
  imageId: number;
  log: FastifyBaseLogger;
}

export interface DeleteGalleryImageResponseDto {
  id: number;
  // the variants for sale that showed only this picture: they show none now, so a buyer does not see them
  variantsWithoutImages: number[];
}

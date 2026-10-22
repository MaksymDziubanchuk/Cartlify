import type { CategoryId, IdParam, ProductId, ReviewId, UserId } from '../ids.js';
import type { Role } from 'types/user.js';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyBaseLogger } from 'fastify';

export type ProductImagePart = {
  file: NodeJS.ReadableStream;
  mimetype: string;
  filename?: string;
};

// an uploaded image that waits under an id of its own until the product is written; then it moves
// to <env>/products/<id>/<position from 1> (placeProductImages)
export type UploadedProductImage = {
  publicId: string;
  urlBase: string;
  position: number; // 0..N-1 (0 is primary)
  alt?: string;
};

export type ProductImagesUrls = {
  url200: string;
  url400: string;
  url800: string;
};

//GET ALL PRODUCTS

// a buyer sorts by createdAt, price (the price it sells at now), popularity, avgRating, name and
// saleEndsAt (the products on sale first); an admin by every field (price: the usual one), the ones
// only some products have with their flag
export type ProductsSortField =
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
  | 'price'
  | 'popularity'
  | 'views'
  | 'avgRating'
  | 'reviewsCount'
  | 'stock'
  | 'totalStock'
  | 'reservedStock'
  | 'expiredStock'
  | 'popularityOverride'
  | 'popularityOverrideUntil'
  | 'saleEndsAt'
  | 'salePrice'
  | 'name';

export type SortOrder = 'asc' | 'desc';

export interface GetAllProductsQueryDto {
  // cursor pagination
  limit?: number; // default 20, max 100
  cursor?: string; // opaque string, created by server (optional for first page)

  // filters
  search?: string;
  categoryIds?: string | string[];
  minPrice?: number;
  maxPrice?: number;

  // admin and root only: true -> only deleted; without it or false -> only not deleted, for every role
  deleted?: boolean;

  // free units (stock - reservedStock): true -> some are free, false -> none are free
  inStock?: boolean;

  // admin and root only: true -> only products with an active sale / with a popularity override;
  // without it or false -> only products without one
  onSale?: boolean;
  popularityOverridden?: boolean;

  // sorting (default popularity desc)
  sort?: ProductsSortField;
  order?: SortOrder;
}

export interface FindAllProductsDto {
  actorRole: Role;

  limit: number;
  cursor?: string;

  search?: string;
  categoryIds?: ProductId[];

  minPrice?: number;
  maxPrice?: number;

  deleted?: boolean;
  inStock?: boolean;
  onSale?: boolean;
  popularityOverridden?: boolean;

  sort: ProductsSortField;
  order: SortOrder;
}

export interface ProductCategoryDto {
  id: CategoryId;
  name: string;
  slug: string;
}

// a product as a buyer (guest, user) gets it; an admin (admin, root) gets the fields below the
// line too. The list of a buyer has the popularity, the card of a buyer does not
export interface ProductResponseDto {
  id: ProductId;
  name: string;
  description?: string;
  price: number;
  // the sale next to the price: a buyer gets it only while it lasts (the product sells at
  // salePrice until saleEndsAt), an admin always, as the row keeps it, null without one
  salePrice?: number | null;
  saleEndsAt?: string | null;
  // free units: the stock that orders do not hold
  stock: number;
  category: ProductCategoryDto;
  images: ProductImagesUrls;
  avgRating: number;
  reviewsCount: number;
  createdAt: string;
  popularity?: number;

  // admin and root only
  views?: number;
  updatedAt?: string;
  totalStock?: number;
  reservedStock?: number;
  // the units of batches that are over: not sold, the admin writes them off
  expiredStock?: number;
  popularityOverride?: number | null;
  popularityOverrideUntil?: string | null;
  deletedAt?: string | null;
}

export interface ProductsResponseDto {
  items: ProductResponseDto[];
  limit: number;
  nextCursor?: string;
}

//GET PRODUCT BY ID
export interface GetProductByIdParamsDto {
  productId: IdParam;
}

export interface FindProductByIdDto {
  productId: ProductId;
  actorId: UserId;
  actorRole: Role;
}

export type FullProductResponseDto = Omit<ProductResponseDto, 'images'> & {
  images: ProductImagesUrls[];
};

// GET PRODUCTS REVIEWS
export interface GetProductReviewsParamsDto {
  productId: IdParam;
}
export interface GetProductReviewsQueryDto {
  cursor?: string;
  limit?: number;
}

export interface FindProductReviewsDto {
  productId: ProductId;
  limit: number;
  cursor?: string;

  actorId: UserId;
  actorRole: Role;
}

// the author of a review as the review shows it; a deleted account is named Guest
export interface ReviewAuthorDto {
  id: UserId;
  name?: string;
  // the own picture, or the drawn letter of an author without one; G on grey for a deleted one
  avatarUrls: {
    url32: string;
    url64: string;
    url128: string;
    url256: string;
  };
  avatarIsDefault: boolean;
  deleted: boolean;
}

export interface ReviewResponseDto {
  id: ReviewId;
  productId: ProductId;
  rating?: number;
  userId: UserId;
  user: ReviewAuthorDto;
  createdAt: Date;
  updatedAt: Date;
  comment?: string;

  upVotes: number;
  downVotes: number;
  userVote?: 'up' | 'down' | null;
}

export interface ReviewsResponseDto {
  items: ReviewResponseDto[];
  limit: number;
  total: number;
  nextCursor?: string;
}

// CREATE PRODUCT
export interface CreateProductBodyDto {
  name: string;
  description?: string;
  price: number;
  categoryId: CategoryId;
  images: MultipartFile[];
}

export interface CreateProductDto {
  actorId: UserId;
  actorRole: Role;
  productId: ProductId;
  name: string;
  description?: string;
  price: number;
  // never taken: a new product has no stock, it comes with a delivery; one sent is refused
  stock?: unknown;
  categoryId: CategoryId;
  images: UploadedProductImage[];
}

export type CreateProductResponseDto = FullProductResponseDto;

// UPDATE PRODUCT
export interface UpdateProductParamsDto {
  productId: IdParam;
}

export interface UpdateProductBodyDto {
  name?: string;
  description?: string;
  price?: number;
  // never taken: the stock changes only with a delivery or a write-off; one sent is refused
  stock?: unknown;
  categoryId?: CategoryId;
  popularityOverride?: number | null;
  popularityOverrideUntil?: string | null;
  // with a price: what happens to the sale that is on. keep keeps it, null takes it off, a new
  // sale takes the old one off and is put on from the new price
  sale?: ProductSaleWord;
}

export interface UpdateProductDto extends UpdateProductBodyDto {
  productId: ProductId;
  actorId: UserId;
  actorRole: Role;
  // the images of a form, they replace the ones the product has
  images?: UploadedProductImage[];
  // a file the product no longer has and that could not be removed goes here
  log: FastifyBaseLogger;
}

export type UpdateProductResponseDto = FullProductResponseDto;

// PRODUCT SALE
// a percent of the price, or an amount of money off it
export type ProductSaleDiscountDto = { percent: number } | { amount: number };

export type ProductSaleDto = ProductSaleDiscountDto & { endsAt: string };

// the word on the sale of a change of a price
export type ProductSaleWord = 'keep' | ProductSaleDto | null;

export type BulkSaleWord = 'keep' | 'remove';

export interface SetProductSaleParamsDto {
  productId: IdParam;
}

export interface SetProductSaleBodyDto {
  // null takes the sale off
  sale: ProductSaleDto | null;
}

export interface SetProductSaleDto extends SetProductSaleBodyDto {
  productId: ProductId;
  actorId: UserId;
  actorRole: Role;
}

export type SetProductSaleResponseDto = FullProductResponseDto;

// BULK UPDATE PRODUCT PRICE

export type BulkProductPriceMode = 'percent' | 'fixed';

export interface BulkProductPriceScopeDto {
  // optional filters (all optional, combined with AND in service)
  categoryId?: CategoryId;
  productIds?: ProductId[];

  minPrice?: number;
  maxPrice?: number;

  inStock?: boolean;
  deleted?: boolean;
}

export interface BulkUpdateProductsPriceBodyDto {
  // how to change price
  mode: BulkProductPriceMode; // 'percent' | 'fixed'
  value: number; // +10 / -10 (percent or fixed depending on mode)

  // optional filters
  scope?: BulkProductPriceScopeDto;

  // optional flags
  dryRun?: boolean;
  reason?: string;

  // the same for the sale that is on of every product: keep it, or take it off
  sale?: BulkSaleWord;
}

export interface BulkUpdateProductsPriceDto extends BulkUpdateProductsPriceBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export interface BulkUpdateProductsPriceResponseDto {
  message: string;
  updatedCount: number;
}

// DELETE PRODUCT BY ID
export interface DeleteProductByIdParamsDto {
  productId: IdParam;
}

export interface DeleteProductByIdDto {
  productId: ProductId;
  actorId: UserId;
  actorRole: Role;
}

export interface DeleteProductByIdResponseDto {
  message: string;
}

// CREATE REVIEW
export interface PostReviewParamsDto {
  productId: IdParam;
}
export interface CreateReviewBodyDto {
  rating?: number;
  comment?: string;
}

export interface CreateReviewDto extends CreateReviewBodyDto {
  productId: ProductId;
  userId: UserId;
  actorRole: Role;
}

export type CreateReviewResponseDto = ReviewResponseDto;

// a new review answers 201, adding the missing part to an existing review answers 200
export interface CreateReviewResultDto {
  review: CreateReviewResponseDto;
  created: boolean;
}

// DETELE REVIEW
export interface DeleteProductReviewParamsDto {
  productId: IdParam;
  reviewId: IdParam;
}

export interface DeleteProductReviewDto {
  productId: ProductId;
  reviewId: ReviewId;
  actorId: UserId;
  actorRole: Role;
}

export interface DeleteProductReviewResponseDto {
  message: string;
}

// UPDATE PRODUCT CATEGORY
export interface UpdateProductCategoryParamsDto {
  productId: IdParam;
}

export interface UpdateProductCategoryBodyDto {
  categoryId: CategoryId;
}

export interface UpdateProductCategoryDto extends UpdateProductCategoryBodyDto {
  productId: ProductId;
  actorId: UserId;
  actorRole: Role;
}

export type UpdateProductCategoryResponseDto = FullProductResponseDto;

// STOCK: a delivery takes in a batch of each item, a write-off takes free units out
// where a batch came from: a supplier, a surplus an inventory found, goods a buyer brought back
export type StockSourceName = 'supplier' | 'surplus' | 'customer_return';

// shortage: what an inventory did not find; returned_to_supplier: goods sent back to the supplier
export type WriteOffReason =
  'damaged' | 'defective' | 'expired' | 'shortage' | 'returned_to_supplier' | 'other';

export interface DeliveryItemBodyDto {
  productId: ProductId;
  quantity: number;
  // the cost of a unit in the currency of the shop, to the cent
  unitCost: number;
  // the last good day, yyyy-mm-dd
  expiresAt?: string;
  supplierBatchNumber?: string;
}

export interface DeliveryBodyDto {
  source: StockSourceName;
  supplier?: string;
  document?: string;
  note?: string;
  items: DeliveryItemBodyDto[];
}

export interface ReceiveStockDto extends DeliveryBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export interface ProductBatchDto {
  id: number;
  productId: ProductId;
  source: StockSourceName;
  supplierBatchNumber: string | null;
  unitCost: number;
  quantity: number;
  remaining: number;
  expiresAt: string | null;
  createdAt: Date;
}

// the stock of a product after the request: free units, the whole stock and the reserve
export interface StockProductSummaryDto {
  id: ProductId;
  stock: number;
  totalStock: number;
  reservedStock: number;
  expiredStock: number;
}

export interface ReceiveStockResponseDto {
  deliveryId: string;
  batches: ProductBatchDto[];
  products: StockProductSummaryDto[];
}

export interface WriteOffItemBodyDto {
  productId: ProductId;
  quantity: number;
  // the batch to take the units from; without one they come in the order of a sale
  batchId?: number;
}

export interface WriteOffBodyDto {
  reason: WriteOffReason;
  note?: string;
  items: WriteOffItemBodyDto[];
}

export interface WriteOffStockDto extends WriteOffBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export interface WriteOffTakenDto {
  batchId: number;
  quantity: number;
  unitCost: number;
}

export interface WriteOffStockResponseDto {
  writeOffId: string;
  items: { productId: ProductId; quantity: number; batches: WriteOffTakenDto[] }[];
  products: StockProductSummaryDto[];
}

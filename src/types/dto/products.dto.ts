import type { CategoryId, IdParam, ProductId, ReviewId, UserId } from '../ids.js';
import type { Role } from 'types/user.js';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyBaseLogger } from 'fastify';
import type { ProductSafety } from '@helpers/productDescription.js';

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
  | 'relevance'
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
  | 'discount'
  | 'sales'
  | 'name';

export type SortOrder = 'asc' | 'desc';

export interface GetAllProductsQueryDto {
  // cursor pagination
  limit?: number; // default 20, max 100
  cursor?: string; // opaque string, created by server (optional for first page)

  // filters
  search?: string;
  categoryIds?: string | string[];
  // the categories with their whole branch (default true) or only the products of each itself
  branch?: boolean;
  minPrice?: number;
  maxPrice?: number;

  // admin and root only: true -> only deleted; without it or false -> only not deleted, for every role
  deleted?: boolean;

  // free units (stock - reservedStock): true -> some are free, false -> none are free
  inStock?: boolean;
  // admin and root only, a flag: at most this many free units, any other mark
  maxStock?: number;
  // admin and root only, a flag: the products that lack the weight or the sizes
  withoutShippingData?: boolean;
  // the period of the sort by sales: the orders paid in it count, [salesFrom, salesTo)
  salesFrom?: string;
  salesTo?: string;

  // admin and root only: true -> only products with an active sale / with a popularity override;
  // without it or false -> only products without one
  onSale?: boolean;
  popularityOverridden?: boolean;

  // sorting (default popularity desc)
  sort?: ProductsSortField;
  order?: SortOrder;
}

export interface FindAllProductsDto {
  // an admin list reads the batches (lastUnitCost) under the context of its admin
  actorId?: UserId;
  actorRole: Role;

  limit: number;
  cursor?: string;

  search?: string;
  categoryIds?: ProductId[];
  branch?: boolean;

  minPrice?: number;
  maxPrice?: number;

  deleted?: boolean;
  inStock?: boolean;
  maxStock?: number;
  withoutShippingData?: boolean;
  salesFrom?: Date;
  salesTo?: Date;
  onSale?: boolean;
  popularityOverridden?: boolean;

  // without it: the best match of a search, or the popularity
  sort?: ProductsSortField;
  order: SortOrder;
}

export interface ProductCategoryDto {
  id: CategoryId;
  name: string;
  slug: string;
}

// the safety and origin data of a product (the EU GPSR) as a request gives them
export interface ProductSafetyInputDto {
  manufacturer: { name: string; address: string; email: string; country: string };
  responsiblePerson?: { name: string; address: string; email: string } | null;
  warnings?: string | null;
}

// a product as a buyer (guest, user) gets it; an admin (admin, root) gets the fields below the
// line too. The list of a buyer has the popularity, the card of a buyer does not
export interface ProductResponseDto {
  id: ProductId;
  name: string;
  description?: string;
  // the article number, null without one
  sku: string | null;
  price: number;
  // the sale next to the price: a buyer gets it only while it lasts (the product sells at
  // salePrice until saleEndsAt), an admin always, as the row keeps it, null without one
  salePrice?: number | null;
  saleEndsAt?: string | null;
  // the lowest price of the 30 days before the sale, the way salePrice is shown
  salePriorPrice?: number | null;
  // free units: the stock that orders do not hold
  stock: number;
  // the weight in grams and the packed sizes in millimetres, null while they are not known. The
  // card shows them to everybody, the list to an admin
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  category: ProductCategoryDto;
  // the primary image of a list item; null for a product without one, which only an admin lists
  images: ProductImagesUrls | null;
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
  // the cost of a unit in the latest delivery of a supplier, null without one
  lastUnitCost?: number | null;
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

// the card: every image, the way to its category from the top of the tree, and the safety and
// origin data, null for a product from before them
export type FullProductResponseDto = Omit<ProductResponseDto, 'images' | 'category'> & {
  category: ProductCategoryDto & { path: ProductCategoryDto[] };
  images: ProductImagesUrls[];
  safety: ProductSafety | null;
};

// GET PRODUCTS REVIEWS
export interface GetProductReviewsParamsDto {
  productId: IdParam;
}
// newest (the default), helpful (the most votes up), ratingHigh, ratingLow (no rating last)
export type ReviewSortName = 'newest' | 'helpful' | 'ratingHigh' | 'ratingLow';

export interface GetProductReviewsQueryDto {
  cursor?: string;
  limit?: number;
  sort?: ReviewSortName;
}

export interface FindProductReviewsDto {
  productId: ProductId;
  limit: number;
  cursor?: string;
  sort?: ReviewSortName;

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
  // the author bought the product: a paid order of it, not cancelled
  verifiedPurchase: boolean;

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
  sku?: string;
  price: number;
  categoryId: CategoryId;
  // the weight and the sizes of the form, text; the service checks them
  weightGrams?: string;
  lengthMm?: string;
  widthMm?: string;
  heightMm?: string;
  // true: the weight and the sizes come later (not kept)
  withoutShippingData?: string;
  images: MultipartFile[];
}

export interface CreateProductDto {
  actorId: UserId;
  actorRole: Role;
  productId: ProductId;
  name: string;
  description?: string;
  // the article number, an empty one is none
  sku?: string;
  // the safety and origin data (GPSR), required: checked by the service
  safety?: unknown;
  price: number;
  // never taken: a new product has no stock, it comes with a delivery; one sent is refused
  stock?: unknown;
  categoryId: CategoryId;
  // the weight and the sizes as they come (text of a form), required unless withoutShippingData
  weightGrams?: unknown;
  lengthMm?: unknown;
  widthMm?: unknown;
  heightMm?: unknown;
  withoutShippingData?: unknown;
  images: UploadedProductImage[];
  log: FastifyBaseLogger;
}

export type CreateProductResponseDto = FullProductResponseDto;

// UPDATE PRODUCT
export interface UpdateProductParamsDto {
  productId: IdParam;
}

export interface UpdateProductBodyDto {
  name?: string;
  description?: string;
  // the article number; an empty one or null takes it away
  sku?: string | null;
  // the safety and origin data, whole: they replace the ones the product has
  safety?: ProductSafetyInputDto;
  price?: number;
  // never taken: the stock changes only with a delivery or a write-off; one sent is refused
  stock?: unknown;
  categoryId?: CategoryId;
  // the weight in grams and the packed sizes in millimetres; null clears them, which needs
  // withoutShippingData; a form gives them as text
  weightGrams?: number | string | null;
  lengthMm?: number | string | null;
  widthMm?: number | string | null;
  heightMm?: number | string | null;
  withoutShippingData?: boolean | string;
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

// A CHANGE OF MANY PRODUCTS: each with fields of its own, the ones of PATCH of one product
// without images; all of them or none
export interface UpdateProductsBatchItemDto extends UpdateProductBodyDto {
  productId: ProductId;
}

export interface UpdateProductsBatchBodyDto {
  items: UpdateProductsBatchItemDto[];
}

export interface UpdateProductsBatchDto extends UpdateProductsBatchBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export interface UpdateProductsBatchResponseDto {
  // the cards of an admin, in the order of the items
  products: FullProductResponseDto[];
}

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
  // a check of the comment that failed goes here
  log: FastifyBaseLogger;
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
  // a mail to the author that failed goes here
  log: FastifyBaseLogger;
}

export interface DeleteProductReviewResponseDto {
  message: string;
  // a removal by a moderator: the removals of the reviews of the author and the limit of the rules
  reviewRemovals?: number;
  reviewRemovalsLimit?: number;
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

// SALES OF MANY PRODUCTS: a sale for each product, or one sale for the products of a category
export interface ProductSalesItemDto {
  productId: ProductId;
  sale: ProductSaleDto;
}

export type ProductSalesBodyDto =
  | { items: ProductSalesItemDto[] }
  | { categoryId: CategoryId; branch?: boolean; sale: ProductSaleDto };

export type SetProductSalesDto = ProductSalesBodyDto & { actorId: UserId; actorRole: Role };

export interface ProductSalesResultDto {
  id: ProductId;
  name: string;
  price: number;
  salePrice: number;
  saleEndsAt: string;
  salePriorPrice: number | null;
  // set: the sale was put on; unchanged: the product had this sale already
  status: 'set' | 'unchanged';
}

export interface ProductSalesResponseDto {
  products: ProductSalesResultDto[];
}

// SUGGESTIONS: a few names of the catalog for what a person types
export interface ProductSuggestionsQueryDto {
  q: string;
}

export interface ProductSuggestionsDto {
  text: string;
  actorId: UserId;
  actorRole: Role;
}

export interface ProductSuggestionsResponseDto {
  items: Array<{ id: ProductId; name: string }>;
}

// PRICE HISTORY: the log of prices of a product, for admin and root
export interface PriceHistoryParamsDto {
  productId: IdParam;
}

export interface PriceHistoryQueryDto {
  limit?: number;
  cursor?: string;
}

export interface PriceHistoryDto extends PriceHistoryQueryDto {
  productId: ProductId;
  actorId: UserId;
  actorRole: Role;
}

export interface PriceHistoryItemDto {
  id: number;
  oldPrice: number;
  newPrice: number;
  // how the change was given: by a percent or by an amount
  mode: 'percent' | 'fixed';
  // its size in that mode, below 0 for a change down
  value: number;
  // a line with an end is the start of a sale
  endsAt: string | null;
  // what made the line (price.set, price.bulk, price.sale_start, ...)
  event: string;
  // the account of root has no id and no name for an admin
  actor: { id: UserId; name: string | null; role: Role; deleted: boolean };
  createdAt: string;
}

export interface PriceHistoryResponseDto {
  items: PriceHistoryItemDto[];
  limit: number;
  nextCursor: string | null;
}

// RESTORE: a product taken out of the catalog goes back
export interface RestoreProductParamsDto {
  productId: IdParam;
}

export interface RestoreProductDto {
  productId: ProductId;
  actorId: UserId;
  actorRole: Role;
}

// STOCK: a delivery takes in a batch of each item, a write-off takes free units out
// where a batch came from: a supplier, a surplus an inventory found, goods a buyer brought back
export type StockSourceName = 'supplier' | 'surplus' | 'customer_return';

// shortage: what an inventory did not find; returned_to_supplier: goods sent back to the supplier
export type WriteOffReason =
  'damaged' | 'defective' | 'expired' | 'shortage' | 'returned_to_supplier' | 'other';

// an item names its product by its id or by its article number, never both (the schema); the
// service turns an article number into the id of the product of the catalog that has it
export type StockProductRefDto =
  { productId: ProductId; sku?: never } | { sku: string; productId?: never };

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

export interface ReceiveStockDto extends Omit<DeliveryBodyDto, 'items'> {
  items: Array<Omit<DeliveryItemBodyDto, 'productId'> & StockProductRefDto>;
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

export interface WriteOffStockDto extends Omit<WriteOffBodyDto, 'items'> {
  items: Array<Omit<WriteOffItemBodyDto, 'productId'> & StockProductRefDto>;
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

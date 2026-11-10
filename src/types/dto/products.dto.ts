import type { WithdrawalRight, WithdrawalRuleName, WithdrawalSource } from '@helpers/withdrawal.js';
import type { CategoryId, IdParam, ProductId, ReviewId, UserId } from '../ids.js';
import type { Role } from 'types/user.js';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyBaseLogger } from 'fastify';
import type { GalleryImageDto, VariantFullDto, VariantShortDto } from './variants.dto.js';

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

// a buyer sorts by createdAt, price (the price a variant sells at now), popularity, avgRating, name,
// sales, relevance and saleEndsAt/discount (the variants on sale first); an admin by every field
// (price: the usual one), the ones only some products have with their flag. A sort by price, sale
// price, discount, end of sale or the stock of a variant makes the rows variants
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
  // the price of a variant (a buyer: the price it sells at now, an admin: the usual price); a price
  // in the query makes the rows variants
  minPrice?: number;
  maxPrice?: number;

  // admin and root only: true -> only deleted; without it or false -> only not deleted, for every role
  deleted?: boolean;

  // free units (stock - reservedStock - units of batches that are over): true -> some are free
  // (a product row: some variant of it has them), false -> none are free
  inStock?: boolean;
  // admin and root only, a flag: the variants with at most this many free units, any other mark
  maxStock?: number;
  // admin and root only, a flag: the variants that lack the weight or the sizes
  withoutShippingData?: boolean;
  // admin and root only, the flags that find the gaps of the catalog (true filters; hiddenFromBuyers
  // false lists the products a buyer sees): the variants that lack a characteristic the category
  // requires, the weight, any of the sizes, the barcode, a picture; the products a buyer does not
  // see; the products with a variant taken out of sale
  missingRequired?: boolean;
  withoutWeight?: boolean;
  withoutDimensions?: boolean;
  withoutBarcode?: boolean;
  withoutImages?: boolean;
  hiddenFromBuyers?: boolean;
  hasDeletedVariants?: boolean;
  // admin and root only: the products of a manufacturer, of a person responsible in the EU, and the
  // products that hold a document (ids of the directory)
  manufacturerId?: number;
  euResponsibleId?: number;
  documentId?: number;
  // the period of the sort by sales: the orders paid in it count, [salesFrom, salesTo)
  salesFrom?: string;
  salesTo?: string;

  // admin and root only: true -> only variants with an active sale / products with a popularity
  // override; without it or false -> only products without one
  onSale?: boolean;
  popularityOverridden?: boolean;

  // the filter by characteristics: one entry for a characteristic, `<attributeId>:<value>` (a list of
  // value ids, a range `from..to`, `yes` or `no`); the parameter repeats. It makes the rows variants
  f?: string | string[];
  // admin and root only: false lists every variant on a row of its own; true (the default) merges
  // the variants of a product with the same main characteristics into one row
  group?: boolean;

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
  missingRequired?: boolean;
  withoutWeight?: boolean;
  withoutDimensions?: boolean;
  withoutBarcode?: boolean;
  withoutImages?: boolean;
  hiddenFromBuyers?: boolean;
  hasDeletedVariants?: boolean;
  manufacturerId?: number;
  euResponsibleId?: number;
  documentId?: number;
  salesFrom?: Date;
  salesTo?: Date;
  onSale?: boolean;
  popularityOverridden?: boolean;

  // the filter by characteristics as the query had it, and the flag group of an admin
  f?: string | string[];
  group?: boolean;

  // without it: the best match of a search, or the popularity
  sort?: ProductsSortField;
  order: SortOrder;
}

// the same question for the code that reads the catalog itself and is no route of it: it may name the
// products it wants (the newsletters read a block of products by hand)
export interface ReadProductsDto extends FindAllProductsDto {
  productIds?: number[];
}

export interface ProductCategoryDto {
  id: CategoryId;
  name: string;
  slug: string;
}

// the manufacturer or the person responsible in the EU a product names (the EU GPSR), as the
// directory of parties keeps it
export interface ProductPartyDto {
  id: number;
  name: string;
  address: string;
  email: string;
  country: string;
}

// a document of the directory of documents a product names: what a buyer opens
export interface ProductDocumentDto {
  id: number;
  title: string;
  kind: 'instruction' | 'certificate' | 'declaration' | 'other';
  url: string;
}

// the product part of an answer, which the variants of it share: a buyer (guest, user) gets what
// helps to buy it, an admin (admin, root) the fields below the line too. The price, the sale, the
// stock, the weight and the article number are the variant's (src/types/dto/variants.dto.ts). The
// list of a buyer has the popularity, the card of a buyer does not
export interface ProductResponseDto {
  id: ProductId;
  name: string;
  description?: string;
  category: ProductCategoryDto;
  avgRating: number;
  reviewsCount: number;
  createdAt: string;
  popularity?: number;

  // admin and root only
  views?: number;
  updatedAt?: string;
  popularityOverride?: number | null;
  popularityOverrideUntil?: string | null;
  deletedAt?: string | null;
}

// a row of the catalog list: a product with its main variant (the query asks nothing of a variant)
// or a variant with its product (it does). A buyer gets the short variant, an admin the full one
export interface ProductListRowDto {
  product: ProductResponseDto;
  variant: VariantShortDto | VariantFullDto;
  // a product row: the lowest and the highest price the variants of the list sell at now (the same
  // when there is one price); a variant row has neither
  minPrice?: number;
  maxPrice?: number;
  // the free units of the row: of the variants of the list for a product row, of the variant for
  // a variant row
  stock: number;
}

export interface ProductsResponseDto {
  items: ProductListRowDto[];
  limit: number;
  // the number of the rows the filters find, whatever the page
  total: number;
  nextCursor?: string;
}

//GET PRODUCT BY ID
export interface GetProductByIdParamsDto {
  productId: IdParam;
}

export interface FindProductByIdDto {
  productId: ProductId;
  variantId?: number;
  actorId: UserId;
  actorRole: Role;
}

// what the law lets a buyer do with the goods when they withdraw: the rule (a buyer's page words
// it) and the kind it makes (full: freely, conditional: only while sealed, none: not at all). An
// admin also gets where the rule comes from: its own value, the source (the product, a category,
// the default) and the category it comes from
export interface ProductWithdrawalDto {
  rule: WithdrawalRuleName;
  right: WithdrawalRight;
  // admin and root only: the rule the product has of its own, null when it follows its category
  own?: WithdrawalRuleName | null;
  source?: WithdrawalSource;
  categoryId?: number | null;
}

// the product of the card: the way to its category from the top of the tree, and the safety and
// origin data (GPSR): the manufacturer, the person responsible in the EU, the warnings; the
// instructions and certificates; the rule of withdrawal. An admin gets the gallery with the
// variants that show each picture
export type ProductCardDto = Omit<ProductResponseDto, 'category'> & {
  category: ProductCategoryDto & { path: ProductCategoryDto[] };
  manufacturer: ProductPartyDto;
  euResponsible: ProductPartyDto | null;
  warnings: string | null;
  documents: ProductDocumentDto[];
  withdrawal: ProductWithdrawalDto;
  // admin and root only
  gallery?: GalleryImageDto[];
};

// the card: the product, the variant it opens (the one asked for, or the main one: the first by its
// place with free units, the first of all when none has), and the short form of every variant to
// switch between. A buyer gets the variants for sale that show a picture, an admin all of them
export interface FullProductResponseDto {
  product: ProductCardDto;
  variant: VariantFullDto;
  variants: VariantShortDto[];
}

export interface GetProductByIdQueryDto {
  // the variant to open; without it the main one
  variantId?: number;
}

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
  // true: the reviews of the authors who bought the product, false: the others; absent: all
  verifiedPurchase?: boolean;
}

export interface FindProductReviewsDto {
  productId: ProductId;
  limit: number;
  cursor?: string;
  sort?: ReviewSortName;
  verifiedPurchase?: boolean;

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
  categoryId: CategoryId;
  // the variants: a JSON list of { price, sku?, barcode?, weightGrams?, lengthMm?, widthMm?,
  // heightMm?, withoutShippingData?, images: [{ file, position }] }; a file is the number of an
  // uploaded file (VariantInputBodyDto, with files for the pictures of the gallery)
  variants: string;
  // the gallery: the files in their order
  images: MultipartFile[];
}

export interface CreateProductDto {
  actorId: UserId;
  actorRole: Role;
  productId: ProductId;
  name: string;
  description?: string;
  // the manufacturer: a party of the directory by its id, or a new one by its four values, one of
  // the two (required); the person responsible in the EU the same, required for a manufacturer
  // outside the EU. Checked by the service
  manufacturerId?: unknown;
  manufacturer?: unknown;
  euResponsibleId?: unknown;
  euResponsible?: unknown;
  warnings?: unknown;
  // the rule of withdrawal of its own: one of the rules, or none (the product follows its category);
  // checked by the service
  withdrawal?: unknown;
  // the ids of the documents of the directory the product names, in their order: the text of a form
  // (ids with a comma between)
  documentIds?: unknown;
  // never taken: a new product has no stock, it comes with a delivery; one sent is refused
  stock?: unknown;
  categoryId: CategoryId;
  // the text of the field `variants`, a JSON list; the service reads and checks it
  variants?: unknown;
  // the gallery: the uploads of the form, in their order
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
  // the manufacturer and the person responsible in the EU by their ids in the directory; null takes
  // the person away; the warnings, null or empty takes them away
  manufacturerId?: number;
  euResponsibleId?: number | null;
  warnings?: string | null;
  // the rule of withdrawal of its own; null or empty gives it up and the product follows its
  // category. Checked by the service (WITHDRAWAL_RULE_INVALID)
  withdrawal?: string | null;
  // the documents the product names, by their ids in their order, written whole; null or empty
  // takes every document away
  documentIds?: number[] | null;
  // never taken: the stock changes only with a delivery or a write-off; one sent is refused
  stock?: unknown;
  categoryId?: CategoryId;
  popularityOverride?: number | null;
  popularityOverrideUntil?: string | null;
}

export interface UpdateProductDto extends UpdateProductBodyDto {
  productId: ProductId;
  actorId: UserId;
  actorRole: Role;
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

// SALE OF VARIANTS
// a percent of the price, or an amount of money off it
export type ProductSaleDiscountDto = { percent: number } | { amount: number };

export type ProductSaleDto = ProductSaleDiscountDto & { endsAt: string };

// the word of a bulk change of prices on the sales that are on: keep them or take them off
export type BulkSaleWord = 'keep' | 'remove';

export interface SetProductSaleParamsDto {
  productId: IdParam;
}

export interface SetProductSaleBodyDto {
  // the variants of the product to put on sale or take off; without it every variant for sale
  variantIds?: number[];
  // null takes the sale off
  sale: ProductSaleDto | null;
}

export interface SetProductSaleDto extends SetProductSaleBodyDto {
  productId: ProductId;
  actorId: UserId;
  actorRole: Role;
}

// what a sale route did to a variant: put the sale on, found the same sale (or no sale to take off)
// and left the variant as it was, took the sale off
export type SaleStatus = 'set' | 'unchanged' | 'removed';

// the variant after a sale route; the sale fields are empty without a sale that lasts
export interface VariantSaleResultDto {
  id: number;
  productId: ProductId;
  name: string;
  price: number;
  salePrice: number | null;
  saleEndsAt: string | null;
  // the lowest price of the 30 days before the sale
  salePriorPrice: number | null;
  status: SaleStatus;
}

export interface SetProductSaleResponseDto {
  // every variant the request named (or every one for sale), in the order of the request
  variants: VariantSaleResultDto[];
}

// BULK UPDATE OF PRICES

export type BulkProductPriceMode = 'percent' | 'fixed';

export interface BulkProductPriceScopeDto {
  // optional filters of the variants (all optional, combined with AND in service)
  categoryId?: CategoryId;
  productIds?: ProductId[];
  variantIds?: number[];

  // the usual price of the variant
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

  // the same for the sale that is on of every variant: keep it, or take it off
  sale?: BulkSaleWord;
}

export interface BulkUpdateProductsPriceDto extends BulkUpdateProductsPriceBodyDto {
  actorId: UserId;
  actorRole: Role;
}

// a variant of a bulk change of prices
export interface BulkPriceVariantDto {
  id: number;
  productId: ProductId;
  name: string;
  oldPrice: number;
  newPrice: number;
}

export interface BulkUpdateProductsPriceResponseDto {
  message: string;
  updatedCount: number;
  // a dry run lists the variants it would change with their old and new price
  variants?: BulkPriceVariantDto[];
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

// SALES OF MANY VARIANTS: a sale for each variant (or for all the variants of a product), or one
// sale for the variants of the products of a category
export type ProductSalesItemDto = { sale: ProductSaleDto } & (
  { variantId: number; productId?: never } | { productId: ProductId; variantId?: never }
);

export type ProductSalesBodyDto =
  | { items: ProductSalesItemDto[] }
  | { categoryId: CategoryId; branch?: boolean; sale: ProductSaleDto };

export type SetProductSalesDto = ProductSalesBodyDto & { actorId: UserId; actorRole: Role };

export interface ProductSalesResponseDto {
  // the variants of the request: in the order of the items, or by id for a category
  variants: VariantSaleResultDto[];
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

// THE PANEL OF THE FILTER of a category (GET /api/products/filters)
export interface CatalogFiltersQueryDto {
  categoryId: number;
  // the category with everything below it (the default) or only its own products
  branch?: boolean;
}

export interface CatalogFiltersDto {
  categoryId: CategoryId;
  branch: boolean;
  actorId: UserId;
  actorRole: Role;
}

// a value of a choice that is in the category, with the colour of its swatch
export interface CatalogFilterOptionDto {
  id: number;
  name: string;
  colorCode: string | null;
  position: number;
}

interface CatalogFilterBaseDto {
  id: number;
  name: string;
  unit: string | null;
  group: { id: number; name: string };
}

// a characteristic of the panel: a choice (one value or a set) gives the values that are there, a
// number its lowest and highest value, yes/no the answers that are there (both: with one answer
// the characteristic is not in the panel)
export type CatalogFilterDto =
  | (CatalogFilterBaseDto & { type: 'option' | 'options'; values: CatalogFilterOptionDto[] })
  | (CatalogFilterBaseDto & { type: 'number'; min: number; max: number })
  | (CatalogFilterBaseDto & { type: 'boolean'; values: Array<'yes' | 'no'> });

export interface CatalogFiltersResponseDto {
  items: CatalogFilterDto[];
}

// PRICE HISTORY: the log of prices of the variants of a product, for admin and root
export interface PriceHistoryParamsDto {
  productId: IdParam;
}

export interface PriceHistoryQueryDto {
  // only the changes of this variant of the product
  variantId?: number;
  limit?: number;
  cursor?: string;
}

export interface PriceHistoryDto extends PriceHistoryQueryDto {
  productId: ProductId;
  actorId: UserId;
  actorRole: Role;
}

// the variant a line of a log of prices names: a short reference, as it is now
export interface LogVariantDto {
  id: number;
  position: number;
  name: string;
  sku: string | null;
}

export interface PriceHistoryItemDto {
  id: number;
  variant: LogVariantDto;
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

// STOCK: a delivery takes in a batch of each item, a write-off takes free units out. The stock is
// the stock of a variant: an item names the variant it is about
// where a batch came from: a supplier, a surplus an inventory found, goods a buyer brought back
export type StockSourceName = 'supplier' | 'surplus' | 'customer_return';

// shortage: what an inventory did not find; returned_to_supplier: goods sent back to the supplier
export type WriteOffReason =
  'damaged' | 'defective' | 'expired' | 'shortage' | 'returned_to_supplier' | 'other';

// an item names its variant by its id, by its article number or by its barcode, one of the three
// (the schema); the service turns an article number or a barcode into the id of the live variant
// of the catalog that has it
export type StockVariantRefDto =
  | { variantId: number; sku?: never; barcode?: never }
  | { sku: string; variantId?: never; barcode?: never }
  | { barcode: string; variantId?: never; sku?: never };

export interface DeliveryItemBodyDto {
  variantId: number;
  quantity: number;
  // the cost of a unit in the currency of the shop, to the cent; the cost of the whole delivery
  // stands in when the item has none
  unitCost?: number;
  // the last good day, yyyy-mm-dd; null: this item has no end, whatever the delivery says
  expiresAt?: string | null;
  supplierBatchNumber?: string;
}

export interface DeliveryBodyDto {
  source: StockSourceName;
  supplier?: string;
  document?: string;
  note?: string;
  // what an item takes when it has no cost or no last good day of its own
  unitCost?: number;
  expiresAt?: string;
  items: DeliveryItemBodyDto[];
}

export interface ReceiveStockDto extends Omit<DeliveryBodyDto, 'items'> {
  items: Array<Omit<DeliveryItemBodyDto, 'variantId'> & StockVariantRefDto>;
  actorId: UserId;
  actorRole: Role;
}

// the product and the variant a line of an answer of the stock is about, by name
export interface StockLineRefDto {
  productId: ProductId;
  variantId: number;
  product: { id: ProductId; name: string };
  variant: { id: number; position: number; name: string; sku: string | null };
}

export interface ProductBatchDto extends StockLineRefDto {
  id: number;
  source: StockSourceName;
  supplierBatchNumber: string | null;
  unitCost: number;
  quantity: number;
  remaining: number;
  expiresAt: string | null;
  createdAt: Date;
}

// the stock of a variant after the request: free units, the whole stock and the reserve
export interface StockVariantSummaryDto {
  variantId: number;
  productId: ProductId;
  stock: number;
  totalStock: number;
  reservedStock: number;
  expiredStock: number;
}

export interface ReceiveStockResponseDto {
  deliveryId: string;
  batches: ProductBatchDto[];
  variants: StockVariantSummaryDto[];
}

export interface WriteOffItemBodyDto {
  variantId: number;
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
  items: Array<Omit<WriteOffItemBodyDto, 'variantId'> & StockVariantRefDto>;
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
  items: Array<StockLineRefDto & { quantity: number; batches: WriteOffTakenDto[] }>;
  variants: StockVariantSummaryDto[];
}

import type { CategoryId, ProductId, ReviewId, UserId } from '../ids.js';
import type { Role } from 'types/user.js';
import type { MultipartFile } from '@fastify/multipart';

export type ProductImagePart = {
  file: NodeJS.ReadableStream;
  mimetype: string;
  filename?: string;
};

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

  // if true -> only deleted, if false -> only not deleted
  deleted?: boolean;

  // if true -> only stock > 0, if false -> only stock == 0
  inStock?: boolean;

  // sorting (default popularity desc)
  sort?: ProductsSortField;
  order?: SortOrder;
}

export interface FindAllProductsDto {
  limit: number;
  cursor?: string;

  search?: string;
  categoryIds?: ProductId[];

  minPrice?: number;
  maxPrice?: number;

  deleted?: boolean;
  inStock?: boolean;

  sort: ProductsSortField;
  order: SortOrder;
}

export interface ProductResponseDto {
  id: ProductId;
  name: string;
  description?: string;
  price: number;
  stock: number;
  categoryId: CategoryId;
  images: ProductImagesUrls;
  createdAt: string;
  updatedAt: string;
  popularity: number;
  views: number;
  avgRating: number;
  reviewsCount: number;
  deletedAt?: string;
}

export interface ProductsResponseDto {
  items: ProductResponseDto[];
  limit: number;
  nextCursor?: string;
}

//GET PRODUCT BY ID
export interface GetProductByIdParamsDto {
  productId: ProductId;
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
  productId: ProductId;
}
export interface GetProductReviewsQueryDto {
  cursorId?: ReviewId;
  limit?: number;
}

export interface FindProductReviewsDto {
  productId: ProductId;
  limit: number;
  cursorId?: ReviewId;
}

export interface ReviewResponseDto {
  id: ReviewId;
  productId: ProductId;
  rating?: number;
  userId: UserId;
  createdAt: Date;
  updatedAt: Date;
  comment?: string;
}

export interface ReviewsResponseDto {
  items: ReviewResponseDto[];
  limit: number;
  total: number;
  nextCursorId?: ReviewId;
}

// CREATE PRODUCT
export interface CreateProductBodyDto {
  name: string;
  description?: string;
  price: number;
  stock: number;
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
  stock: number;
  categoryId: CategoryId;
  images: UploadedProductImage[];
}

export type CreateProductResponseDto = FullProductResponseDto;

// UPDATE PRODUCT
export interface UpdateProductParamsDto {
  productId: ProductId;
}

export interface UpdateProductBodyDto {
  name?: string;
  description?: string;
  price?: number;
  stock?: number;
  categoryId?: CategoryId;
  images?: UploadedProductImage[];
  popularityOverride?: number | null;
  popularityOverrideUntil?: string | null;
}

export interface UpdateProductDto extends UpdateProductBodyDto {
  productId: ProductId;
  actorId: UserId;
  actorRole: Role;
}

export type UpdateProductResponseDto = FullProductResponseDto;

// DELETE PRODUCT BY ID
export interface DeleteProductByIdParamsDto {
  productId: ProductId;
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
  productId: ProductId;
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

// DETELE REVIEW
export interface DeleteProductReviewParamsDto {
  productId: ProductId;
  reviewId: ReviewId;
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
  productId: ProductId;
}

export interface UpdateProductCategoryBodyDto {
  categoryId: CategoryId;
}

export interface UpdateProductCategoryDto
  extends UpdateProductCategoryParamsDto,
    UpdateProductCategoryBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export type UpdateProductCategoryResponseDto = FullProductResponseDto;

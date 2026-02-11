import type { CategoryId, ProductId, ReviewId, UserId } from '../ids.js';
import type { Role } from 'types/user.js';
import type { MultipartFile } from '@fastify/multipart';

export type ProductImagesUrls = {
  url200: string;
  url400: string;
  url800: string;
};

//GET ALL PRODUCTS

export interface GetAllProductsQueryDto {
  page?: number;
  limit?: number;
  search?: string;
  categoryIds?: CategoryId[];
  minPrice?: number;
  maxPrice?: number;
  sortBy?: 'price' | 'createdAt' | 'name' | 'popular';
  order?: 'asc' | 'desc';
}
export interface FindAllProductsDto {
  page: number;
  limit: number;
  search?: string;
  categoryIds?: CategoryId[];
  minPrice?: number;
  maxPrice?: number;
  sortBy: 'price' | 'createdAt' | 'popular' | 'name';
  order: 'asc' | 'desc';
}
export interface ProductResponseDto {
  id: ProductId;
  name: string;
  description?: string;
  price: number;
  stock: number;
  categoryId: CategoryId;
  images: ProductImagesUrls;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  popularity?: number;
  views?: number;
  avgRating?: number;
  reviewsCount?: number;
}

export interface ProductsResponseDto {
  items: ProductResponseDto[];
  page?: number;
  limit?: number;
  total?: number;
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

export interface CreateProductDto extends CreateProductBodyDto {
  actorId: UserId;
  actorRole: Role;
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
  images?: MultipartFile[];
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

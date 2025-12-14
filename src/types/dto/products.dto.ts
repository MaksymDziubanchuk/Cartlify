import type { CategoryId, ProductId, ReviewId, UserId } from '../ids.js';

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
  categoryId: CategoryId;
  createdAt: Date;
  updatedAt: Date;
  images?: string[];
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

export interface GetProductByIdParamsDto {
  productId: ProductId;
}

export interface FindProductByIdDto {
  productId: ProductId;
}

export type GetProductByIdResponseDto = ProductResponseDto;

export interface GetProductReviewsParamsDto {
  productId: ProductId;
}
export interface GetProductReviewsQueryDto {
  page?: number;
  limit?: number;
}

export interface FindProductReviewsDto {
  productId: ProductId;
  page: number;
  limit: number;
}

export interface ReviewResponseDto {
  id: ReviewId;
  productId: ProductId;
  rating: number;
  userId: UserId;
  createdAt: Date;
  comment?: string;
}

export interface ReviewsResponseDto {
  items: ReviewResponseDto[];
  page?: number;
  limit?: number;
  total?: number;
}

export interface CreateProductBodyDto {
  name: string;
  description?: string;
  price: number;
  categoryId: CategoryId;
  images?: string[];
}

export type CreateProductDto = CreateProductBodyDto;

export type CreateProductResponseDto = ProductResponseDto;

export interface UpdateProductParamsDto {
  productId: ProductId;
}

export interface UpdateProductBodyDto {
  name?: string;
  description?: string;
  price?: number;
  categoryId?: CategoryId;
  images?: string[];
  popularity?: number;
}

export interface UpdateProductDto extends UpdateProductBodyDto {
  productId: ProductId;
}

export type UpdateProductResponseDto = ProductResponseDto;

export interface DeleteProductByIdParamsDto {
  productId: ProductId;
}

export interface DeleteProductByIdDto {
  productId: ProductId;
}

export interface DeleteProductByIdResponseDto {
  message: string;
}

export interface PostReviewParamsDto {
  productId: ProductId;
}
export interface CreateReviewBodyDto {
  rating: number;
  comment?: string;
}

export interface CreateReviewDto extends CreateReviewBodyDto {
  productId: ProductId;
  userId: UserId;
}

export type CreateReviewResponseDto = ReviewResponseDto;

export interface DeleteProductReviewParamsDto {
  productId: ProductId;
  reviewId: ReviewId;
}

export interface DeleteProductReviewDto {
  productId: ProductId;
  reviewId: ReviewId;
  actorId: UserId;
}

export interface DeleteProductReviewResponseDto {
  message: string;
}

export interface UpdateProductCategoryParamsDto {
  productId: ProductId;
}

export interface UpdateProductCategoryBodyDto {
  categoryId: CategoryId;
}

export interface UpdateProductCategoryDto {
  productId: ProductId;
  categoryId: CategoryId;
}

export interface UpdateProductCategoryResponseDto {
  message: string;
}

export interface RemoveProductCategoryParamsDto {
  productId: ProductId;
}

export interface RemoveProductCategoryDto {
  productId: ProductId;
}
export interface RemoveProductCategoryResponseDto {
  message: string;
}

import { CategoryId, ProductId, ReviewId, UserId } from '../ids.js';

export interface CreateProductDto {
  name: string;
  description?: string;
  price: number;
  categoryId: CategoryId;
  imageUrl?: string;
}

export interface UpdateProductDto {
  name?: string;
  description?: string;
  price?: number;
  categoryId?: CategoryId;
  imageUrl?: string;
}

export interface CreateReviewDto {
  rating: number;
  comment?: string;
}

export interface ProductResponseDto {
  id: ProductId;
  name: string;
  description?: string;
  price: number;
  categoryId: CategoryId;
  imageUrl?: string;
}

export interface ReviewResponseDto {
  id: ReviewId;
  productId: ProductId;
  rating: number;
  comment?: string;
  userId: UserId;
}

export interface ProductsListQueryDto {
  page?: number;
  limit?: number;
  search?: string;
  categoryId?: CategoryId;
  minPrice?: number;
  maxPrice?: number;
  sortBy?: 'price' | 'name' | 'createdAt';
  order?: 'asc' | 'desc';
}

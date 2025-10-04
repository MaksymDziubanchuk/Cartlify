import type { UserId, ProductId } from 'types/ids.js';
import type { ProductResponseDto } from 'types/dto/products.dto.js';

export interface GetFavoritesQueryDto {
  page?: number;
  limit?: number;
}

export interface FindFavoritesDto {
  userId: UserId;
  page: number;
  limit: number;
}

export interface FavoriteItemDto {
  product: ProductResponseDto;
  addedAt: Date;
}
export interface GetFavoritesResponseDto {
  items: FavoriteItemDto[];
  page?: number;
  limit?: number;
  total?: number;
}

export interface ToggleFavoriteParamsDto {
  productId: ProductId;
}

export interface ToggleFavoriteDto {
  userId: UserId;
  productId: ProductId;
}

export interface ToggleFavoriteResponseDto {
  isFavorite: boolean;
}

export interface DeleteFavoriteParamsDto {
  productId: ProductId;
}

export interface DeleteFavoriteDto {
  userId: UserId;
  productId: ProductId;
}

export interface DeleteFavoriteResponseDto {
  message: string;
}

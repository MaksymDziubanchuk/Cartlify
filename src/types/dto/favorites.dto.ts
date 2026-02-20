import type { UserId, ProductId } from 'types/ids.js';
import type { ProductResponseDto } from 'types/dto/products.dto.js';
import type { Role } from 'types/user.js';

export interface GetFavoritesQueryDto {
  limit?: number;
  cursor?: string;
}

export interface FindFavoritesDto {
  actorId: UserId;
  actorRole: Role;
  limit: number;
  cursor?: string;
}

export interface FavoriteItemDto {
  product: ProductResponseDto;
  addedAt: Date;
}

export interface GetFavoritesResponseDto {
  items: FavoriteItemDto[];
  nextCursor: string | null;
}

export interface AddFavoriteParamsDto {
  productId: ProductId;
}

export interface AddFavoriteDto {
  actorId: UserId;
  actorRole: Role;
  productId: ProductId;
}

export interface AddFavoriteResponseDto {
  productId: ProductId;
  isFavorite: true;
}

export interface DeleteFavoriteParamsDto {
  productId: ProductId;
}

export interface DeleteFavoriteDto {
  actorId: UserId;
  actorRole: Role;
  productId: ProductId;
}

export interface DeleteFavoriteResponseDto {
  productId: ProductId;
  isFavorite: false;
}

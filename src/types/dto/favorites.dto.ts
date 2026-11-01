import type { UserId, IdParam } from 'types/ids.js';
import type { ProductResponseDto } from 'types/dto/products.dto.js';
import type { VariantShortDto } from 'types/dto/variants.dto.js';
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

// a favorite is a variant of a product: a row of the list names both, the way the other lists do
export interface FavoriteItemDto {
  product: ProductResponseDto;
  variant: VariantShortDto;
  addedAt: Date;
}

export interface GetFavoritesResponseDto {
  items: FavoriteItemDto[];
  nextCursor: string | null;
}

export interface AddFavoriteParamsDto {
  variantId: IdParam;
}

export interface AddFavoriteDto {
  actorId: UserId;
  actorRole: Role;
  variantId: number;
}

export interface AddFavoriteResponseDto {
  variantId: number;
  isFavorite: true;
}

export interface DeleteFavoriteParamsDto {
  variantId: IdParam;
}

export interface DeleteFavoriteDto {
  actorId: UserId;
  actorRole: Role;
  variantId: number;
}

export interface DeleteFavoriteResponseDto {
  variantId: number;
  isFavorite: false;
}

import type {
  FindFavoritesDto,
  ToggleFavoriteDto,
  DeleteFavoriteDto,
} from 'types/dto/favorites.dto.js';
import type { MessageResponseDto } from 'types/common.js';

async function findFavorites({
  userId,
  page,
  limit,
}: FindFavoritesDto): Promise<MessageResponseDto> {
  return { message: 'favorites list not implemented' };
}

async function toggleFavorite({
  userId,
  productId,
}: ToggleFavoriteDto): Promise<MessageResponseDto> {
  return { message: 'toggle favorite not implemented' };
}

async function deleteFavorite({
  userId,
  productId,
}: DeleteFavoriteDto): Promise<MessageResponseDto> {
  return { message: 'delete favorite not implemented' };
}

export const favoritesServices = {
  findFavorites,
  toggleFavorite,
  deleteFavorite,
};

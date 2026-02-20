import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import type { ProductId } from 'types/ids.js';
import type {
  GetFavoritesQueryDto,
  GetFavoritesResponseDto,
  FindFavoritesDto,
  AddFavoriteParamsDto,
  AddFavoriteDto,
  AddFavoriteResponseDto,
  DeleteFavoriteParamsDto,
  DeleteFavoriteDto,
  DeleteFavoriteResponseDto,
} from 'types/dto/favorites.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { favoritesServices } from './favorites.services.js';

const getFavorites: ControllerRouter<
  {},
  {},
  GetFavoritesQueryDto,
  GetFavoritesResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const limitRaw = req.query?.limit;
  const cursor = req.query?.cursor;

  const limit = limitRaw == null ? 20 : Number(limitRaw);

  const args = pickDefined<FindFavoritesDto>({ actorId, actorRole, limit }, { cursor });
  const result = await favoritesServices.findFavorites(args);

  return reply.code(200).send(result);
};

const postAddFavorite: ControllerRouter<
  AddFavoriteParamsDto,
  {},
  {},
  AddFavoriteResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const productId = Number(req.params.productId) as ProductId;

  const args = pickDefined<AddFavoriteDto>({ actorId, actorRole, productId }, {});

  const result = await favoritesServices.addFavorite(args);

  return reply.code(200).send(result);
};

const deleteFavorite: ControllerRouter<
  DeleteFavoriteParamsDto,
  {},
  {},
  DeleteFavoriteResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const productId = Number(req.params.productId) as ProductId;

  const args = pickDefined<DeleteFavoriteDto>({ actorId, actorRole, productId }, {});

  const result = await favoritesServices.deleteFavorite(args);

  return reply.code(200).send(result);
};
export const favoritesController = {
  getFavorites,
  postAddFavorite,
  deleteFavorite,
};

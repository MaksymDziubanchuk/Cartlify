import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import type {
  GetFavoritesQueryDto,
  FindFavoritesDto,
  AddFavoriteParamsDto,
  AddFavoriteDto,
  DeleteFavoriteParamsDto,
  DeleteFavoriteDto,
} from 'types/dto/favorites.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { favoritesServices } from './favorites.services.js';

const getFavorites: ControllerRouter<{}, {}, GetFavoritesQueryDto, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  const { page: qp, limit: ql } = req.query;
  const page = qp ? Number(qp) : 1;
  const limit = ql ? Number(ql) : 10;

  const args = pickDefined<FindFavoritesDto>({ userId: id, page, limit }, {});
  const result = await favoritesServices.findFavorites(args);
  return reply.code(200).send(result);
};

const postAddFavorite: ControllerRouter<AddFavoriteParamsDto, {}, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  const { productId } = req.params;

  const args = pickDefined<AddFavoriteDto>({ userId: id, productId }, {});
  const result = await favoritesServices.toggleFavorite(args);
  return reply.code(200).send(result);
};

const deleteFavorite: ControllerRouter<
  DeleteFavoriteParamsDto,
  {},
  {},
  MessageResponseDto
> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  const { productId } = req.params;

  const args = pickDefined<DeleteFavoriteDto>({ userId: id, productId }, {});
  const result = await favoritesServices.deleteFavorite(args);
  return reply.code(200).send(result);
};

export const favoritesController = {
  getFavorites,
  postAddFavorite,
  deleteFavorite,
};

import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import type {
  GetUserByIdParamsDto,
  FindUserByIdDto,
  FindMeByIdDto,
  UpdateMeBodyDto,
  UpdateMeDto,
} from 'types/dto/users.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { usersServices } from './users.services.js';

const getMe: ControllerRouter<{}, {}, {}, MessageResponseDto> = async (req, reply) => {
  const { id } = req.user as UserEntity;

  const args = pickDefined<FindMeByIdDto>({ userId: id }, {});
  const result = await usersServices.findMe(args);
  return reply.code(200).send(result);
};

const patchMe: ControllerRouter<{}, UpdateMeBodyDto, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  const { name, avatarUrl, locale, phone } = req.body;

  const args = pickDefined<UpdateMeDto>({ userId: id }, { name, avatarUrl, locale, phone });
  const result = await usersServices.updateMe(args);
  return reply.code(200).send(result);
};

const getUserById: ControllerRouter<GetUserByIdParamsDto, {}, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const userId = Number(req.params.userId);

  const args = pickDefined<FindUserByIdDto>({ userId }, {});
  const result = await usersServices.findById(args);
  return reply.code(200).send(result);
};

export const usersController = {
  getMe,
  patchMe,
  getUserById,
};

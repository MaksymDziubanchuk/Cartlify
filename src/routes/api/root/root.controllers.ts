import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import type {
  GetAdminsQueryDto,
  FindAdminsDto,
  GetAdminsResponseDto,
  AddAdminBodyDto,
  AddAdminDto,
  AddAdminResponseDto,
  DeleteAdminParamsDto,
  DeleteAdminDto,
  DeleteAdminResponseDto,
} from 'types/dto/root.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { rootServices } from './root.services.js';

const getAdmins: ControllerRouter<{}, {}, GetAdminsQueryDto, GetAdminsResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const { limit, cursor, search } = req.query;

  const args = pickDefined<FindAdminsDto>(
    {
      actorId,
      actorRole,
      limit: limit ?? 10,
    },
    { cursor, search },
  );

  const result = await rootServices.findAdmins(args);

  return reply.code(200).send(result);
};

const postAdmin: ControllerRouter<{}, AddAdminBodyDto, {}, AddAdminResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const { userId } = req.body;

  const args = pickDefined<AddAdminDto>({ actorId, userId, actorRole }, {});

  const result = await rootServices.addAdmin(args);
  return reply.code(201).send(result);
};

const deleteAdmin: ControllerRouter<DeleteAdminParamsDto, {}, {}, DeleteAdminResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as UserEntity;

  const { adminId: pid } = req.params;
  const adminId = Number(pid);

  const args = pickDefined<DeleteAdminDto>({ actorId, actorRole, adminId }, {});

  const result = await rootServices.removeAdmin(args);

  return reply.code(200).send(result);
};

export const rootAdminsController = {
  getAdmins,
  postAdmin,
  deleteAdmin,
};

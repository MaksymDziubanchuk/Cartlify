import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import type {
  GetAdminsQueryDto,
  FindAdminsDto,
  AddAdminBodyDto,
  AddAdminDto,
  DeleteAdminParamsDto,
  DeleteAdminDto,
} from 'types/dto/root.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { rootServices } from './root.services.js';

const getAdmins: ControllerRouter<{}, {}, GetAdminsQueryDto, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { page: qp, limit: ql, search } = req.query;
  const page = qp ? Number(qp) : 1;
  const limit = ql ? Number(ql) : 10;
  const args = pickDefined<FindAdminsDto>({ page, limit }, { search });
  const result = await rootServices.findAdmins(args);
  return reply.code(200).send(result);
};

const postAdmin: ControllerRouter<{}, AddAdminBodyDto, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId } = req.user as UserEntity;
  const { userId } = req.body;
  const args = pickDefined<AddAdminDto>({ actorId, userId }, {});
  const result = await rootServices.addAdmin(args);
  return reply.code(201).send(result);
};

const deleteAdmin: ControllerRouter<DeleteAdminParamsDto, {}, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId } = req.user as UserEntity;
  const { adminId } = req.params;
  const args = pickDefined<DeleteAdminDto>({ actorId, adminId }, {});
  const result = await rootServices.removeAdmin(args);
  return reply.code(200).send(result);
};

export const rootAdminsController = {
  getAdmins,
  postAdmin,
  deleteAdmin,
};

import type { ControllerRouter } from 'types/controller.js';
import type { MultipartFile } from '@fastify/multipart';
import type { UserEntity } from 'types/user.js';
import type {
  GetUserByIdParamsDto,
  UserResponseDto,
  FindUserByIdDto,
  FindMeByIdDto,
  UpdateMeBodyDto,
  UpdateMeDto,
  UserByIdResponseDto,
  DeleteUserByIdDto,
} from 'types/dto/users.dto.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UploadImageResult } from '@utils/cloudinary.util.js';

import { BadRequestError } from '@utils/errors.js';

import pickDefined from '@helpers/parameterNormalize.js';
import { usersServices } from './users.services.js';
import { UserId } from 'types/ids.js';

const getMe: ControllerRouter<{}, {}, {}, UserResponseDto> = async (req, reply) => {
  const { id } = req.user as UserEntity;

  const args = pickDefined<FindMeByIdDto>({ userId: id }, {});
  const result = await usersServices.findMe(args);
  return reply.code(200).send(result);
};

const patchMe: ControllerRouter<{}, UpdateMeBodyDto, {}, UserResponseDto> = async (req, reply) => {
  // actor identity comes from authGuard
  const { id, role } = req.user as UserEntity;

  // collect optional scalar fields from multipart or json
  let name: string | undefined;
  let locale: string | undefined;
  let phone: string | undefined;

  // start avatar upload as soon as we see the file part to avoid hanging multipart parsing
  let avatarUpload: Promise<UploadImageResult> | null = null;

  if (req.isMultipart()) {
    // parse multipart parts manually because file streams must be consumed during parsing
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname === 'avatar') {
          // prevent sending multiple avatar files in one request
          if (avatarUpload) {
            // always drain extra streams to avoid request hanging
            part.file.resume();
            throw new BadRequestError('AVATAR_MULTIPLE');
          }

          // delegate cloudinary upload to a dedicated service
          // this call must start consuming the stream immediately
          avatarUpload = usersServices.beginAvatarUpload({
            userId: id as UserId,
            avatar: { file: part.file, mimetype: part.mimetype, filename: part.filename },
          });
        } else {
          // ignore unexpected file fields but drain their streams
          part.file.resume();
        }
        continue;
      }

      // multipart field values are typed loosely, normalize to string
      const v = typeof part.value === 'string' ? part.value : String(part.value ?? '');

      // map allowed fields only
      if (part.fieldname === 'name') name = v;
      else if (part.fieldname === 'locale') locale = v;
      else if (part.fieldname === 'phone') phone = v;
    }
  } else {
    // allow json updates when client sends no files
    const b = req.body ?? {};
    name = b.name;
    locale = b.locale;
    phone = b.phone;
  }

  // wait for avatar upload if it was requested, otherwise keep it null
  const uploaded = avatarUpload ? await avatarUpload : null;

  // build service dto with only provided fields
  const args = pickDefined<UpdateMeDto>(
    { userId: id, userRole: role },
    { name, locale, phone, avatarUploaded: uploaded },
  );

  // persist changes and return the updated user dto
  const result = await usersServices.updateMe(args);
  return reply.code(200).send(result);
};

const getUserById: ControllerRouter<GetUserByIdParamsDto, {}, {}, UserByIdResponseDto> = async (
  req,
  reply,
) => {
  const userId = Number(req.params.userId);

  const args = pickDefined<FindUserByIdDto>({ userId }, {});
  const result = await usersServices.findById(args);
  return reply.code(200).send(result);
};

const deleteUserById: ControllerRouter<GetUserByIdParamsDto, {}, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId } = req.user as UserEntity;
  const userId = Number(req.params.userId);

  const args = pickDefined<DeleteUserByIdDto>({ actorId, userId }, {});
  const result = await usersServices.deleteUserById(args);
  return reply.code(200).send(result);
};

export const usersController = {
  getMe,
  patchMe,
  getUserById,
  deleteUserById,
};

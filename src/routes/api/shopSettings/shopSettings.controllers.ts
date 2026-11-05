import { BadRequestError } from '@utils/errors.js';
import { discardUploads } from '@utils/cloudinary.util.js';

import type { ControllerRouter } from 'types/controller.js';
import type {
  GetShopSettingsHistoryResponseDto,
  PublicShopSettingsDto,
  PutShopSettingsBodyDto,
  ShopSettingsFieldDto,
  ShopSettingsValuesDto,
  UploadedShopLogo,
} from 'types/dto/shopSettings.dto.js';
import type { UserEntity } from 'types/user.js';

import {
  getPublicShopSettings,
  getShopSettingsField,
  getShopSettingsHistory,
  getShopSettingsMissingFields,
  getShopSettingsValues,
  putShopSettings,
} from './shopSettings.services.js';
import { beginShopLogoUpload, setShopLogo } from './services/setShopLogo.service.js';
import { removeShopLogo } from './services/removeShopLogo.service.js';

// public: GET /api/shop-settings
const getPublic: ControllerRouter<{}, {}, {}, PublicShopSettingsDto> = async (_req, reply) =>
  reply.code(200).send(getPublicShopSettings());

// admin, root: GET /api/admin/shop-settings
const getValues: ControllerRouter<{}, {}, {}, ShopSettingsValuesDto> = async (_req, reply) =>
  reply.code(200).send(getShopSettingsValues());

// admin, root: GET /api/admin/shop-settings/:key
const getField: ControllerRouter<{ key: string }, {}, {}, ShopSettingsFieldDto> = async (
  req,
  reply,
) => reply.code(200).send(getShopSettingsField(req.params.key));

// admin, root: GET /api/admin/shop-settings/missing
const getMissing: ControllerRouter<{}, {}, {}, { fields: string[] }> = async (_req, reply) =>
  reply.code(200).send({ fields: getShopSettingsMissingFields() });

// root: PUT /api/root/shop-settings
const putValues: ControllerRouter<{}, PutShopSettingsBodyDto, {}, ShopSettingsValuesDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  const result = await putShopSettings({ actorId: id, body: req.body });
  return reply.code(200).send(result);
};

// root: GET /api/root/shop-settings/history
const getHistory: ControllerRouter<
  {},
  {},
  { limit?: number; cursor?: string },
  GetShopSettingsHistoryResponseDto
> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  const result = await getShopSettingsHistory({
    actorId: id,
    actorRole: 'ROOT',
    limit: req.query.limit ?? 20,
    cursor: req.query.cursor,
  });
  return reply.code(200).send(result);
};

// root: POST /api/root/shop-settings/logo
const postLogo: ControllerRouter<{}, {}, {}, ShopSettingsValuesDto> = async (req, reply) => {
  const { id: actorId } = req.user as UserEntity;

  if (!req.isMultipart()) throw new BadRequestError('MULTIPART_REQUIRED');

  let upload: Promise<UploadedShopLogo> | undefined;

  try {
    for await (const part of req.parts()) {
      // text fields say nothing here
      if (part.type !== 'file') continue;

      if (part.fieldname !== 'image') {
        part.file.resume();
        continue;
      }

      // one logo per request
      if (upload) {
        part.file.resume();
        throw new BadRequestError('SHOP_LOGO_MULTIPLE');
      }

      upload = beginShopLogoUpload({
        file: part.file,
        mimetype: part.mimetype,
        filename: part.filename,
      });
      // awaited after the loop; a failure before that must not stop the process
      upload.catch(() => undefined);
    }

    if (!upload) throw new BadRequestError('SHOP_LOGO_REQUIRED');

    const result = await setShopLogo({ actorId, upload, log: req.log });
    return reply.code(200).send(result);
  } catch (err) {
    // the picture that waits on Cloudinary goes with the refused request
    if (upload) await discardUploads([upload], req.log);
    throw err;
  }
};

// root: DELETE /api/root/shop-settings/logo
const deleteLogo: ControllerRouter<{}, {}, {}, ShopSettingsValuesDto> = async (req, reply) => {
  const { id: actorId } = req.user as UserEntity;
  const result = await removeShopLogo({ actorId, log: req.log });
  return reply.code(200).send(result);
};

export const shopSettingsController = {
  getPublic,
  getValues,
  getField,
  getMissing,
  putValues,
  getHistory,
  postLogo,
  deleteLogo,
};

import { putShopSettingBodySchemas } from '@schemas/dto/shopSettings.dtoSchemas.js';
import { BadRequestError } from '@utils/errors.js';
import { discardUploads } from '@utils/cloudinary.util.js';

import type { FastifyRequest } from 'fastify';
import type { WritableShopSettingKey } from '@config/shopSettings.js';
import type { ControllerRouter } from 'types/controller.js';
import type {
  GetShopSettingsHistoryResponseDto,
  PublicShopSettingsDto,
  PutShopSettingBodyDto,
  PutShopSettingsBodyDto,
  ShopSettingsValuesDto,
  UploadedShopLogo,
} from 'types/dto/shopSettings.dto.js';
import type { UserEntity } from 'types/user.js';

import {
  getPublicShopSettings,
  getShopSettingsHistory,
  getShopSettingsMissingFields,
  getShopSettingsValues,
  putShopSetting,
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

// the body of PUT /api/root/shop-settings/:key is the value of that one setting, of the shape of
// its own field: a schema of a body cannot depend on the path, so it is checked here, by the
// validator of the routes (the same rules, coercion and formats as PUT /api/root/shop-settings).
// A value out of its shape is the 400 VALIDATION_ERROR of a schema (errorNormalizer)
function assertSettingBody(req: FastifyRequest, key: WritableShopSettingKey): void {
  const validate = req.compileValidationSchema(putShopSettingBodySchemas[key], 'body');
  if (validate(req.body)) return;

  throw Object.assign(new Error(`body/value of ${key} is invalid`), {
    statusCode: 400,
    validation: validate.errors ?? [],
    validationContext: 'body',
  });
}

// root: PUT /api/root/shop-settings/:key
const putValue: ControllerRouter<
  { key: WritableShopSettingKey },
  PutShopSettingBodyDto,
  {},
  ShopSettingsValuesDto
> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  assertSettingBody(req, req.params.key);
  const result = await putShopSetting({ actorId: id, key: req.params.key, value: req.body.value });
  return reply.code(200).send(result);
};

// root: GET /api/root/shop-settings/history
const getHistory: ControllerRouter<
  {},
  {},
  { limit?: number; cursor?: string; key?: string },
  GetShopSettingsHistoryResponseDto
> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  const result = await getShopSettingsHistory({
    actorId: id,
    actorRole: 'ROOT',
    limit: req.query.limit ?? 20,
    cursor: req.query.cursor,
    key: req.query.key,
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
  getMissing,
  putValues,
  putValue,
  getHistory,
  postLogo,
  deleteLogo,
};

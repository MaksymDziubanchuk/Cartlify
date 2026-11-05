import { randomUUID } from 'node:crypto';

import type { FastifyBaseLogger } from 'fastify';

import { writeShopLogo } from '@config/shopSettings.js';
import {
  deleteImage,
  isOwnFile,
  makePublicId,
  makeUploadPublicId,
  moveImage,
  requireImageStream,
  uploadImage,
} from '@utils/cloudinary.util.js';
import { InternalError, isAppError } from '@utils/errors.js';

import type {
  ShopLogoImagePart,
  ShopSettingsValuesDto,
  UploadedShopLogo,
} from 'types/dto/shopSettings.dto.js';
import type { UserId } from 'types/ids.js';

// reads the file of the form into Cloudinary at once, under an id of its own: setShopLogo moves it
// to its place once the new version is written, a refused request deletes it (the controller)
export async function beginShopLogoUpload(image: ShopLogoImagePart): Promise<UploadedShopLogo> {
  const safeStream = await requireImageStream(image.file, {
    mimetype: image.mimetype,
    emptyCode: 'SHOP_LOGO_STREAM_ERROR',
  });

  const uploaded = await uploadImage({
    publicId: makeUploadPublicId(),
    file: safeStream,
    mimetype: image.mimetype,
    ...(image.filename ? { filename: image.filename } : {}),
    tags: ['shop-logo'],
  });

  return { publicId: uploaded.publicId };
}

// puts the picture that waits on Cloudinary at the place of the logo and writes the new version;
// the one the shop had before is deleted once the write lands
export async function setShopLogo(dto: {
  actorId: UserId;
  upload: Promise<UploadedShopLogo>;
  log: Pick<FastifyBaseLogger, 'warn'>;
}): Promise<ShopSettingsValuesDto> {
  const { actorId, log } = dto;
  const waiting = await dto.upload;

  // the file at its place, known to the catch below: a failure after the move leaves no one's file
  let placed: string | undefined;

  try {
    const moved = await moveImage(
      waiting.publicId,
      // a new path for every upload: the move never replaces the picture the shop shows, and
      // nothing of the path is cached to drop
      makePublicId({ kind: 'shop', imageKey: randomUUID() }),
      { invalidate: false },
    );
    placed = moved.publicId;

    const { settings, oldLogoPublicId } = await writeShopLogo({
      actorId,
      logoUrl: moved.urlBase,
      logoPublicId: moved.publicId,
    });

    // the picture the shop had is no one's now; a failure is only logged
    if (isOwnFile(oldLogoPublicId)) {
      try {
        await deleteImage(oldLogoPublicId);
      } catch (err) {
        log.warn({ err, publicId: oldLogoPublicId }, 'old logo of the shop was not deleted');
      }
    }

    const { logoPublicId: _logoPublicId, ...result } = settings;
    return result;
  } catch (err) {
    if (placed) {
      try {
        await deleteImage(placed);
      } catch (deleteErr) {
        log.warn({ err: deleteErr, publicId: placed }, 'logo of a refused request was not deleted');
      }
    }

    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'SHOP_LOGO_SET_UNEXPECTED' }, err);
  }
}

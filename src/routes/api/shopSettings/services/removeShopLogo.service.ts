import type { FastifyBaseLogger } from 'fastify';

import { shopSettings, writeShopLogo } from '@config/shopSettings.js';
import { deleteImage, isOwnFile } from '@utils/cloudinary.util.js';
import { ConflictError, InternalError, isAppError } from '@utils/errors.js';

import type { ShopSettingsValuesDto } from 'types/dto/shopSettings.dto.js';
import type { UserId } from 'types/ids.js';

// takes the logo off the shop: a new version without it, the file deleted after the write lands.
// Checked against the cache, not a fresh read: the server is a single process, the cache is never
// behind a write of its own (writeShopLogo refreshes it before this runs again)
export async function removeShopLogo(dto: {
  actorId: UserId;
  log: Pick<FastifyBaseLogger, 'warn'>;
}): Promise<ShopSettingsValuesDto> {
  const { actorId, log } = dto;
  if (!shopSettings().logoUrl) throw new ConflictError('SHOP_LOGO_NOT_SET');

  try {
    const { settings, oldLogoPublicId } = await writeShopLogo({
      actorId,
      logoUrl: null,
      logoPublicId: null,
    });

    if (isOwnFile(oldLogoPublicId)) {
      try {
        await deleteImage(oldLogoPublicId);
      } catch (err) {
        log.warn({ err, publicId: oldLogoPublicId }, 'logo of the shop was not deleted');
      }
    }

    const { logoPublicId: _logoPublicId, ...result } = settings;
    return result;
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'SHOP_LOGO_REMOVE_UNEXPECTED' }, err);
  }
}

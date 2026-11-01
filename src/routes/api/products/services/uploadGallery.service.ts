import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { MAX_PRODUCT_IMAGES } from '@config/limits.js';
import { inAdminTx } from '@routes/api/attributes/services/helpers/directory.helper.js';
import { BadRequestError } from '@utils/errors.js';
import type { UploadImageResult } from '@utils/cloudinary.util.js';

import {
  assertProductThere,
  discardMovedImages,
  imagesTxTimeout,
  lockProductThere,
  moveStagedImages,
  nextGalleryPosition,
  normalizeFindProductByIdInput,
  readGallery,
  stageProductImages,
} from './helpers/index.js';

import type {
  GalleryRoomDto,
  GalleryRoomResponseDto,
  UploadGalleryDto,
  UploadGalleryResponseDto,
} from 'types/dto/variants.dto.js';

// The first look at the gallery of POST /api/products/:productId/images, before the files of the
// form are read or uploaded: a product that is not there is 404, a gallery that is full is 400
// (PRODUCT_IMAGES_TOO_MANY), so that a request that is refused anyway costs no upload. Only a first
// look: the transaction of the upload counts the pictures again, under the lock of the product
export async function readGalleryRoom(dto: GalleryRoomDto): Promise<GalleryRoomResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);

  return inAdminTx(
    { actorId: dto.actorId, actorRole: dto.actorRole },
    'GALLERY_ROOM_UNEXPECTED',
    async (tx) => {
      await assertProductThere(tx, productId);

      const have = await tx.productImage.count({ where: { productId } });
      if (have >= MAX_PRODUCT_IMAGES) {
        throw new BadRequestError('PRODUCT_IMAGES_TOO_MANY', { max: MAX_PRODUCT_IMAGES, have });
      }

      return { have };
    },
  );
}

// POST /api/products/:productId/images: more pictures for the gallery of a product that is there.
// They take the next places of the gallery; no variant shows them until it is told to (a change of
// the variant, PATCH .../variants/:variantId). The uploads wait under ids of their own and move to
// their places once the rows are written; a refused request leaves no files. The answer is the
// whole gallery. The gallery has PRODUCT_IMAGES_MAX pictures at most. The row of the product is
// locked first: the count and the places are read and written under it, so two uploads to one
// gallery keep the limit and take places of their own
export async function uploadGallery(dto: UploadGalleryDto): Promise<UploadGalleryResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);
  const actor = { actorId: dto.actorId, actorRole: dto.actorRole };

  if (!dto.images.length) throw new BadRequestError('PRODUCT_IMAGES_REQUIRED');

  // a retried transaction must not move the same upload twice
  const moved = new Map<string, UploadImageResult>();

  try {
    return await inAdminTx(
      actor,
      'GALLERY_UPLOAD_UNEXPECTED',
      async (tx) => {
        await lockProductThere(tx, productId);

        const have = await tx.productImage.count({ where: { productId } });
        if (have + dto.images.length > MAX_PRODUCT_IMAGES) {
          throw new BadRequestError('PRODUCT_IMAGES_TOO_MANY', { max: MAX_PRODUCT_IMAGES, have });
        }

        const staged = await stageProductImages({
          tx,
          productId,
          uploads: dto.images,
          firstPosition: await nextGalleryPosition(tx, productId),
        });

        // an edit of the product: its last edit moves
        await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() } });
        await writeAdminAuditLog(tx, {
          actorId: dto.actorId,
          actorRole: dto.actorRole,
          entityType: 'product',
          entityId: productId,
          action: 'PRODUCT_UPDATE',
          event: 'product.gallery_add',
          changes: [{ field: 'images', old: null, new: staged.map((image) => image.id) }],
        });

        // the files move last, once every row is written
        await moveStagedImages({ tx, staged, moved });

        return { images: await readGallery(tx, productId) };
      },
      undefined,
      // the moves at cloudinary run inside the transaction: it is given time for each file
      { timeout: imagesTxTimeout(dto.images.length) },
    );
  } catch (err) {
    // the transaction went back: the uploads that moved to the paths of the product before the
    // failure have no row, they go (the ones still waiting go in the controller)
    await discardMovedImages(moved, dto.log);
    throw err;
  }
}

import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { inAdminTx } from '@routes/api/attributes/services/helpers/directory.helper.js';
import { NotFoundError } from '@utils/errors.js';

import {
  deleteStaleImages,
  lockProductThere,
  normalizeFindProductByIdInput,
} from './helpers/index.js';

import type {
  DeleteGalleryImageDto,
  DeleteGalleryImageResponseDto,
} from 'types/dto/variants.dto.js';

// DELETE /api/products/:productId/images/:imageId: takes a picture out of the gallery. The
// variants that showed it do not show it any more (the database takes the bindings with it); the
// answer names the variants for sale that are left without a picture, which a buyer does not see
// until they get one. The file goes from Cloudinary after the commit
export async function deleteGalleryImage(
  dto: DeleteGalleryImageDto,
): Promise<DeleteGalleryImageResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);
  const { imageId } = dto;
  const actor = { actorId: dto.actorId, actorRole: dto.actorRole };

  const { result, publicId } = await inAdminTx(actor, 'GALLERY_DELETE_UNEXPECTED', async (tx) => {
    // the row of the product first, the way every request that binds pictures to variants takes its
    // locks: the delete waits for them and they wait for it, in one order
    await lockProductThere(tx, productId);

    const image = await tx.productImage.findFirst({
      where: { id: imageId, productId },
      select: { id: true, publicId: true },
    });
    if (!image) throw new NotFoundError('PRODUCT_IMAGE_NOT_FOUND');

    const bound = await tx.variantImage.findMany({
      where: { imageId },
      select: { variantId: true },
    });
    const boundIds = bound.map((row) => row.variantId);

    await tx.productImage.delete({ where: { id: imageId } });

    // the variants for sale that showed only this picture
    const left = boundIds.length
      ? await tx.productVariant.findMany({
          where: { id: { in: boundIds }, deletedAt: null, images: { none: {} } },
          select: { id: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        })
      : [];

    await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() } });
    await writeAdminAuditLog(tx, {
      actorId: dto.actorId,
      actorRole: dto.actorRole,
      entityType: 'product',
      entityId: productId,
      action: 'PRODUCT_UPDATE',
      event: 'product.gallery_remove',
      changes: [
        { field: 'images', old: [imageId], new: null },
        ...(boundIds.length ? [{ field: 'variantIds', old: boundIds, new: null }] : []),
      ],
    });

    return {
      result: { id: imageId, variantsWithoutImages: left.map((row) => row.id) },
      publicId: image.publicId,
    };
  });

  // the picture is gone from the gallery: its file goes
  await deleteStaleImages([publicId], dto.log, productId);

  return result;
}

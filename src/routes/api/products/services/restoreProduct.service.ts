import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { ConflictError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import {
  knownVariantDbError,
  normalizeFindProductByIdInput,
  readAdminCard,
} from './helpers/index.js';

import type { FullProductResponseDto, RestoreProductDto } from 'types/dto/products.dto.js';

// puts a product taken out of the catalog back: the catalog, the search and the cart see it again,
// and so do its variants that went with it (the database puts back the ones taken out of sale
// together with the product; a variant an admin took out of sale before stays out). The admin log
// keeps the change of deletedAt (PRODUCT_UPDATE); a product of the catalog is 409
// PRODUCT_NOT_DELETED, an article number or a barcode of a variant that another live variant took
// meanwhile is 409 PRODUCT_SKU_TAKEN or VARIANT_BARCODE_TAKEN. The answer is the card of an admin
export async function restoreProduct(dto: RestoreProductDto): Promise<FullProductResponseDto> {
  assertAdminActor(dto.actorId, dto.actorRole);

  const { productId } = normalizeFindProductByIdInput(dto);
  const { actorId, actorRole } = dto;

  try {
    await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const before = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, deletedAt: true },
      });
      if (!before) throw new NotFoundError('PRODUCT_NOT_FOUND');
      if (!before.deletedAt) throw new ConflictError('PRODUCT_NOT_DELETED');

      const after = await tx.product.update({
        where: { id: productId },
        data: { deletedAt: null },
        select: { id: true },
      });

      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'product',
        entityId: after.id,
        action: 'PRODUCT_UPDATE',
        event: 'product.restore',
        changes: [{ field: 'deletedAt', old: before.deletedAt.toISOString(), new: null }],
      });
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    // the variants come back with the product: one whose code another live variant took meanwhile
    // stops it (the unique indexes of db/06)
    const known = await knownVariantDbError(err);
    if (known) throw known;

    throw new InternalError({ reason: 'PRODUCTS_RESTORE_UNEXPECTED' }, err);
  }

  return readAdminCard({ actorId, actorRole }, productId);
}

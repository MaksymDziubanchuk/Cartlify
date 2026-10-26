import { expiredUnitsNow } from '@db/expiredStock.helper.js';
import { lastUnitCostsNow } from '@db/lastUnitCost.helper.js';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { ConflictError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import {
  isSkuTaken,
  mapProductRowToResponse,
  normalizeFindProductByIdInput,
  productResponseSelect,
  readCategoryPath,
  readProductImageUrls,
} from './helpers/index.js';

import type { FullProductResponseDto, RestoreProductDto } from 'types/dto/products.dto.js';

// puts a product taken out of the catalog back: the catalog, the search and the cart see it again.
// The admin log keeps the change of deletedAt (PRODUCT_UPDATE); a product of the catalog is 409
// PRODUCT_NOT_DELETED, its article number taken by another product of the catalog meanwhile is
// 409 PRODUCT_SKU_TAKEN
export async function restoreProduct(dto: RestoreProductDto): Promise<FullProductResponseDto> {
  assertAdminActor(dto.actorId, dto.actorRole);

  const { productId } = normalizeFindProductByIdInput(dto);
  const { actorId, actorRole } = dto;

  try {
    const restored = await prisma.$transaction(async (tx) => {
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
        select: productResponseSelect,
      });

      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'product',
        entityId: after.id,
        action: 'PRODUCT_UPDATE',
        changes: [{ field: 'deletedAt', old: before.deletedAt.toISOString(), new: null }],
      });

      return after;
    });

    const images = await readProductImageUrls(restored.id);
    const expired = await expiredUnitsNow([restored.id]);
    const costs = await lastUnitCostsNow({ actorId, actorRole }, [restored.id]);

    return mapProductRowToResponse({
      product: {
        ...restored,
        expiredStock: expired.get(restored.id) ?? 0,
        lastUnitCost: costs.get(restored.id) ?? null,
      },
      images,
      categoryPath: await readCategoryPath(restored.category.id),
      view: 'admin',
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    // one product of the catalog has an article number at a time
    if (isSkuTaken(err)) throw new ConflictError('PRODUCT_SKU_TAKEN');

    throw new InternalError({ reason: 'PRODUCTS_RESTORE_UNEXPECTED' }, err);
  }
}

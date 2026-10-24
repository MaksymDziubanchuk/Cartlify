import { expiredUnitsNow } from '@db/expiredStock.helper.js';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { InternalError, BadRequestError, NotFoundError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import { toNumberSafe } from '@helpers/safeNormalizer.js';
import {
  mapProductRowToResponse,
  productResponseSelect,
  readCategoryPath,
  readProductImageUrls,
  normalizeFindProductByIdInput,
  assertCategoryExists,
} from './helpers/index.js';

import type {
  UpdateProductCategoryDto,
  UpdateProductCategoryResponseDto,
} from 'types/dto/products.dto.js';
import type { AuditChange } from '@db/adminAudit.helper.js';

export async function updateProductCategory({
  productId,
  categoryId,
  actorId,
  actorRole,
}: UpdateProductCategoryDto): Promise<UpdateProductCategoryResponseDto> {
  // validate actor context for rls and admin-only create
  assertAdminActor(actorId, actorRole);

  // normalize and validate ids
  const { productId: productIdRaw } = normalizeFindProductByIdInput({ productId });

  const categoryIdRaw = toNumberSafe(categoryId);
  if (categoryIdRaw == null || !Number.isInteger(categoryIdRaw) || categoryIdRaw <= 0) {
    throw new BadRequestError('CATEGORY_ID_INVALID');
  }

  try {
    // update category and write admin audit log in the same tx
    const updated = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // load previous category for audit
      const before = await tx.product.findUnique({
        where: { id: productIdRaw },
        select: { id: true, categoryId: true },
      });
      if (!before) throw new NotFoundError('PRODUCT_NOT_FOUND');
      await assertCategoryExists(tx, categoryIdRaw);

      const product = await tx.product.update({
        where: { id: productIdRaw },
        data: { categoryId: categoryIdRaw },
        select: productResponseSelect,
      });

      // build audit changes only for category update
      const changes: AuditChange[] =
        before.categoryId !== product.categoryId
          ? [{ field: 'categoryId', old: before.categoryId, new: product.categoryId }]
          : [];

      // write admin audit log for category update
      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'product',
        entityId: product.id,
        action: 'PRODUCT_UPDATE',
        changes,
      });

      return product;
    });

    // fetch all product images and map urls
    const images = await readProductImageUrls(updated.id);
    const expired = await expiredUnitsNow([updated.id]);

    // map db row into api dto
    return mapProductRowToResponse({
      product: { ...updated, expiredStock: expired.get(updated.id) ?? 0 },
      images,
      categoryPath: await readCategoryPath(updated.category.id),
      view: 'admin',
    });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_UPDATE_CATEGORY_UNEXPECTED' }, err);
  }
}

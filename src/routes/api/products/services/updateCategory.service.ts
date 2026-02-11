import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { AppError, BadRequestError, NotFoundError, isAppError } from '@utils/errors.js';

import { toNumberSafe } from '@helpers/safeNormalizer.js';
import {
  mapProductRowToResponse,
  writeAdminAuditLog,
  readProductImageUrls,
  normalizeFindProductByIdInput,
} from './helpers/index.js';

import type {
  UpdateProductCategoryDto,
  UpdateProductCategoryResponseDto,
} from 'types/dto/products.dto.js';
import type { AuditChange } from './helpers/index.js';

export async function updateProductCategory({
  productId,
  categoryId,
  actorId,
  actorRole,
}: UpdateProductCategoryDto): Promise<UpdateProductCategoryResponseDto> {
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

      const product = await tx.product.update({
        where: { id: productIdRaw },
        data: { categoryId: categoryIdRaw },
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          stock: true,
          categoryId: true,
          views: true,
          popularity: true,
          avgRating: true,
          reviewsCount: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
        },
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

    // map db row into api dto
    return mapProductRowToResponse({
      product: updated,
      images,
    });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`products.updateProductCategory: unexpected (${msg})`, 500);
  }
}

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { AppError, BadRequestError, NotFoundError, isAppError } from '@utils/errors.js';

import { toNumberSafe } from '@helpers/safeNormalizer.js';
import {
  mapProductRowToResponse,
  buildProductUpdateAuditChanges,
  writeAdminAuditLog,
} from './helpers/index.js';

import type {
  UpdateProductCategoryDto,
  UpdateProductCategoryResponseDto,
} from 'types/dto/products.dto.js';

export async function updateProductCategory({
  productId,
  categoryId,
  actorId,
  actorRole,
}: UpdateProductCategoryDto): Promise<UpdateProductCategoryResponseDto> {
  // normalize and validate ids
  const productIdRaw = toNumberSafe(productId);
  if (productIdRaw == null || !Number.isInteger(productIdRaw) || productIdRaw <= 0) {
    throw new BadRequestError('PRODUCT_ID_INVALID');
  }

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
          categoryId: true,
          views: true,
          popularity: true,
          avgRating: true,
          reviewsCount: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const auditChanges = buildProductUpdateAuditChanges(
        {
          name: product.name,
          description: product.description,
          price: product.price,
          categoryId: before.categoryId,
          popularity: product.popularity,
        } as any,
        {
          after: product as any,
          input: { categoryId },
        },
      );

      await writeAdminAuditLog(tx, {
        actorId: actorId,
        actorRole: actorRole,
        entityType: 'product',
        entityId: product.id,
        action: 'PRODUCT_UPDATE',
        changes: auditChanges,
      });

      return product;
    });

    // fetch all product images and map urls
    const imageRows = await prisma.productImage.findMany({
      where: { productId: updated.id },
      select: { url: true, position: true },
      orderBy: { position: 'asc' },
    });

    // map db row into api dto
    return mapProductRowToResponse({
      product: updated,
      ...(imageRows?.length ? { images: imageRows } : {}),
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

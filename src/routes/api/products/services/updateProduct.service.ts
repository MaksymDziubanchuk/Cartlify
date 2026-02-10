import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  isAppError,
} from '@utils/errors.js';

import { toNumberSafe, toStringSafe } from '@helpers/safeNormalizer.js';
import {
  normalizeMultipartFiles,
  uploadProductImages,
  persistProductImages,
  mapProductRowToResponse,
  buildProductUpdateAuditChanges,
  writeAdminAuditLog,
  writeProductPriceChangeLog,
  computeFixedDelta,
} from './helpers/index.js';

import type { UpdateProductDto, UpdateProductResponseDto } from 'types/dto/products.dto.js';

export async function updateProduct({
  productId,
  actorId,
  actorRole,
  name,
  description,
  price,
  categoryId,
  images,
  popularity,
}: UpdateProductDto): Promise<UpdateProductResponseDto> {
  // validate actor context for rls and admin-only update
  if (!Number.isInteger(actorId)) throw new ForbiddenError('ACTOR_ID_INVALID');
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN');

  // normalize and validate ids
  const productIdRaw = toNumberSafe(productId);
  if (productIdRaw == null || !Number.isInteger(productIdRaw) || productIdRaw <= 0) {
    throw new BadRequestError('PRODUCT_ID_INVALID');
  }

  const categoryIdRaw = categoryId != null ? toNumberSafe(categoryId) : undefined;
  if (categoryId != null) {
    if (categoryIdRaw == null || !Number.isInteger(categoryIdRaw) || categoryIdRaw <= 0) {
      throw new BadRequestError('CATEGORY_ID_INVALID');
    }
  }

  // normalize and validate scalar fields when provided
  const nameRaw = name != null ? toStringSafe(name) : undefined;
  const descriptionRaw = description != null ? toStringSafe(description) : undefined;
  const priceRaw = price != null ? toNumberSafe(price) : undefined;
  const popularityRaw = popularity != null ? toNumberSafe(popularity) : undefined;

  const nameNorm = typeof nameRaw === 'string' ? nameRaw.trim() : undefined;
  const descriptionNorm = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : undefined;

  if (name != null && (!nameNorm || !nameNorm.length))
    throw new BadRequestError('PRODUCT_NAME_INVALID');

  if (price != null && (priceRaw == null || !Number.isFinite(priceRaw) || priceRaw < 0)) {
    throw new BadRequestError('PRODUCT_PRICE_INVALID');
  }

  if (popularity != null) {
    if (popularityRaw == null || !Number.isInteger(popularityRaw) || popularityRaw < 0) {
      throw new BadRequestError('POPULARITY_INVALID');
    }
  }

  // normalize multipart images into file parts for upload
  const imageParts = normalizeMultipartFiles(images);

  try {
    // update product and optionally clear old image pointers
    const updated = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // load previous state for audit and price change log
      const before = await tx.product.findUnique({
        where: { id: productIdRaw },
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          categoryId: true,
          popularity: true,
        },
      });
      if (!before) throw new NotFoundError('PRODUCT_NOT_FOUND');

      if (imageParts.length)
        await tx.productImage.deleteMany({ where: { productId: productIdRaw } });

      const updated = await tx.product.update({
        where: { id: productIdRaw },
        data: {
          ...(name != null ? { name: nameNorm as string } : {}),
          ...(description != null ? { description: descriptionNorm ? descriptionNorm : null } : {}),
          ...(price != null ? { price: new Prisma.Decimal(priceRaw as number) } : {}),
          ...(categoryId != null ? { categoryId: categoryIdRaw as number } : {}),
          ...(popularity != null ? { popularity: popularityRaw as number } : {}),
        },
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

      // build diff list for admin audit log
      const auditChanges = buildProductUpdateAuditChanges(before, {
        after: updated,
        input: { name, description, price, categoryId, popularity },
      });

      // write admin audit log for product update
      if (auditChanges.length) {
        // write admin audit log for product update
        await writeAdminAuditLog(tx, {
          actorId,
          actorRole,
          entityType: 'product',
          entityId: updated.id,
          action: 'PRODUCT_UPDATE',
          changes: auditChanges,
        });
      }

      // write product price change log when price actually changed
      if (price != null && before.price.toString() !== updated.price.toString()) {
        await writeProductPriceChangeLog(tx, {
          productId: updated.id,
          actorId,
          beforePrice: before.price,
          afterPrice: updated.price,
          mode: 'fixed',
          value: computeFixedDelta(before.price, updated.price),
        });
      }

      return updated;
    });

    // upload images outside tx to avoid external calls inside db transaction
    if (imageParts.length) {
      const uploads = await uploadProductImages({ productId: updated.id, imageParts });

      await prisma.$transaction(async (tx) => {
        // set db session context for rls policies
        await setUserContext(tx, { userId: actorId, role: actorRole });

        // persist uploaded image pointers
        await persistProductImages({ tx, productId: updated.id, uploads });
      });
    }

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

    throw new AppError(`products.updateProduct: unexpected (${msg})`, 500);
  }
}

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
  readProductImageUrls,
  normalizeFindProductByIdInput,
  normalizeUpdateProductInput,
  assertAdminActor,
} from './helpers/index.js';

import type { UpdateProductDto, UpdateProductResponseDto } from 'types/dto/products.dto.js';

export async function updateProduct({
  productId,
  actorId,
  actorRole,
  name,
  description,
  price,
  stock,
  categoryId,
  images,
  popularityOverride,
  popularityOverrideUntil,
}: UpdateProductDto): Promise<UpdateProductResponseDto> {
  // validate actor context for rls and admin-only update
  assertAdminActor(actorId, actorRole);

  // normalize and validate id
  const { productId: productIdRaw } = normalizeFindProductByIdInput({ productId });

  // normalize and validate scalar fields when provided
  const {
    nameNorm,
    descriptionNorm,
    priceRaw,
    stockRaw,
    categoryIdRaw,
    popularityOverrideRaw,
    popularityOverrideUntilDate,
  } = normalizeUpdateProductInput({
    name,
    description,
    price,
    stock,
    categoryId,
    popularityOverride,
    popularityOverrideUntil,
  });

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
          stock: true,
          categoryId: true,
          popularityOverride: true,
          popularityOverrideUntil: true,
          popularity: true,
          deletedAt: true,
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
          ...(stock != null ? { stock: stockRaw as number } : {}),
          ...(categoryId != null ? { categoryId: categoryIdRaw as number } : {}),

          ...(popularityOverride !== undefined
            ? { popularityOverride: popularityOverrideRaw as any }
            : {}),
          ...(popularityOverrideUntil !== undefined
            ? { popularityOverrideUntil: popularityOverrideUntilDate as any }
            : {}),
        },
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          stock: true,
          categoryId: true,
          popularityOverride: true,
          popularityOverrideUntil: true,
          popularity: true,
          views: true,
          avgRating: true,
          reviewsCount: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // build diff list for admin audit log
      const auditChanges = buildProductUpdateAuditChanges(before, {
        after: updated,
        input: {
          name,
          description,
          price,
          stock,
          categoryId,
          popularityOverride,
          popularityOverrideUntil,
        },
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

    throw new AppError(`products.updateProduct: unexpected (${msg})`, 500);
  }
}

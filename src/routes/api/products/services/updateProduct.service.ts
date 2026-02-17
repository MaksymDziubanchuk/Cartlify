import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { buildProductUpdateAuditChanges, writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  isAppError,
} from '@utils/errors.js';

import {
  persistProductImages,
  mapProductRowToResponse,
  writeProductPriceChangeLog,
  computeFixedDelta,
  readProductImageUrls,
  normalizeFindProductByIdInput,
  normalizeUpdateProductInput,
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

  // normalize and validate provided fields
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

  // reject empty patch
  const hasImages = Array.isArray(images) && images.length > 0;
  const hasAnyUpdates =
    hasImages ||
    name !== undefined ||
    description !== undefined ||
    price !== undefined ||
    stock !== undefined ||
    categoryId !== undefined ||
    popularityOverride !== undefined ||
    popularityOverrideUntil !== undefined;

  if (!hasAnyUpdates) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  try {
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

      // replace image pointers only when new images provided
      if (hasImages) {
        await tx.productImage.deleteMany({ where: { productId: productIdRaw } });
        await persistProductImages({ tx, productId: productIdRaw, uploads: images! });
      }

      // build update payload only for provided fields
      const data: Prisma.ProductUpdateInput = {
        ...(name !== undefined ? { name: nameNorm! } : {}),
        ...(description !== undefined
          ? { description: descriptionNorm ? descriptionNorm : null }
          : {}),
        ...(price !== undefined ? { price: new Prisma.Decimal(priceRaw!) } : {}),
        ...(stock !== undefined ? { stock: stockRaw! } : {}),
        ...(categoryId !== undefined ? { categoryId: categoryIdRaw! } : {}),
      };

      if (popularityOverride === null) {
        data.popularityOverride = null; // explicit clear
      } else if (popularityOverride !== undefined) {
        data.popularityOverride = popularityOverrideRaw as number; // set number
      }

      if (popularityOverrideUntil === null) {
        data.popularityOverrideUntil = null; // explicit clear
      } else if (popularityOverrideUntil !== undefined) {
        data.popularityOverrideUntil = popularityOverrideUntilDate as Date; // set date
      }

      // touch when images-only update
      if (!Object.keys(data).length) {
        data.updatedAt = new Date();
      }

      const after = await tx.product.update({
        where: { id: productIdRaw },
        data,
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

      if (!after) throw new NotFoundError('PRODUCT_NOT_FOUND');

      // build diff list for admin audit log
      const auditChanges = buildProductUpdateAuditChanges(before, {
        after,
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

      // write admin audit log when something actually changed
      if (auditChanges.length) {
        await writeAdminAuditLog(tx, {
          actorId,
          actorRole,
          entityType: 'product',
          entityId: after.id,
          action: 'PRODUCT_UPDATE',
          changes: auditChanges,
        });
      }

      // write product price change log when price changed
      if (price !== undefined && before.price.toString() !== after.price.toString()) {
        await writeProductPriceChangeLog(tx, {
          productId: after.id,
          actorId,
          beforePrice: before.price,
          afterPrice: after.price,
          mode: 'fixed',
          value: computeFixedDelta(before.price, after.price),
        });
      }

      return after;
    });

    // fetch images and map urls
    const imageRows = await readProductImageUrls(updated.id as any);

    return mapProductRowToResponse({ product: updated, images: imageRows });
  } catch (err) {
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`products.updateProduct: unexpected (${msg})`, 500);
  }
}

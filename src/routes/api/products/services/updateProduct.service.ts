import { Prisma } from '@prisma/client';
import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { buildProductUpdateAuditChanges, writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { isRetryableTxError } from '@db/client.js';

import {
  AppError,
  BadRequestError,
  NotFoundError,
  isAppError,
  ResourceBusyError,
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
    const updated = await tx(
      async (db) => {
        // set db session context for rls policies
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait to avoid hanging on concurrent updates
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // lock product row to serialize concurrent patches (including stock)
        await db.$queryRaw`SELECT id FROM cartlify.products WHERE id = ${productIdRaw} FOR UPDATE`;

        // load previous state for audit and price change log
        const before = await db.product.findUnique({
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
          await db.productImage.deleteMany({ where: { productId: productIdRaw } });
          await persistProductImages({ tx: db, productId: productIdRaw, uploads: images! });
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

        // apply explicit nulls only when client asked to clear values
        if (popularityOverride === null) {
          data.popularityOverride = null;
        } else if (popularityOverride !== undefined) {
          data.popularityOverride = popularityOverrideRaw as number;
        }

        if (popularityOverrideUntil === null) {
          data.popularityOverrideUntil = null;
        } else if (popularityOverrideUntil !== undefined) {
          data.popularityOverrideUntil = popularityOverrideUntilDate as Date;
        }

        // touch when images-only update
        if (!Object.keys(data).length) {
          data.updatedAt = new Date();
        }

        // persist product update under row lock
        const after = await db.product.update({
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
          await writeAdminAuditLog(db, {
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
          await writeProductPriceChangeLog(db, {
            productId: after.id,
            actorId,
            beforePrice: before.price,
            afterPrice: after.price,
            mode: 'fixed',
            value: computeFixedDelta(before.price, after.price),
          });
        }

        return after;
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );

    // fetch images and map urls
    const imageRows = await readProductImageUrls(updated.id as any);

    // map db row into api dto
    return mapProductRowToResponse({ product: updated, images: imageRows });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) {
      throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
    }
    throw new AppError(`products.updateProduct: unexpected`, 500);
  }
}

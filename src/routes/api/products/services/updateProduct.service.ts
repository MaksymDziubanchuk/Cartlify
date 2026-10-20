import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { buildProductUpdateAuditChanges, writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { deleteImage, isOwnFile, type UploadImageResult } from '@utils/cloudinary.util.js';

import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  isAppError,
  ResourceBusyError,
} from '@utils/errors.js';

import {
  placeProductImages,
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
  log,
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

  // a retried transaction must not move the same upload twice
  const moved = new Map<string, UploadImageResult>();

  try {
    const { after: updated, staleFiles } = await tx(
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
            reservedStock: true,
            categoryId: true,
            popularityOverride: true,
            popularityOverrideUntil: true,
            popularity: true,
            deletedAt: true,
          },
        });
        if (!before) throw new NotFoundError('PRODUCT_NOT_FOUND');

        // use stock as delta (negative value takes units off)
        const newStock = stockRaw !== undefined ? before.stock + stockRaw : undefined;

        // take off only free units (real stock = stock - reservedStock)
        if (newStock !== undefined && newStock < before.reservedStock) {
          throw new ConflictError('INSUFFICIENT_AVAILABLE_STOCK', {
            productId: before.id,
            available: before.stock - before.reservedStock,
            requested: -stockRaw!,
          });
        }

        // build update payload only for provided fields
        const data: Prisma.ProductUpdateInput = {
          ...(name !== undefined ? { name: nameNorm! } : {}),
          ...(description !== undefined
            ? { description: descriptionNorm ? descriptionNorm : null }
            : {}),
          ...(price !== undefined ? { price: new Prisma.Decimal(priceRaw!) } : {}),
          ...(stock !== undefined ? { stock: newStock! } : {}),
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
            reservedStock: true,
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
            beforePrice: before.price,
            afterPrice: after.price,
            mode: 'fixed',
            value: computeFixedDelta(before.price, after.price),
          });
        }

        // the new images replace the old ones last, once every other row is written: the uploads
        // move to the paths of the product only for a request that is taken
        let staleFiles: string[] = [];
        if (hasImages) {
          const old = await db.productImage.findMany({
            where: { productId: productIdRaw },
            select: { publicId: true },
          });
          await db.productImage.deleteMany({ where: { productId: productIdRaw } });
          const kept = await placeProductImages({
            tx: db,
            productId: productIdRaw,
            uploads: images!,
            moved,
          });

          // a file the product no longer has; only the files of this environment are its own
          staleFiles = old
            .map((row) => row.publicId)
            .filter((publicId) => isOwnFile(publicId) && !kept.includes(publicId)) as string[];
        }

        return { after, staleFiles };
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        // the moves at cloudinary run inside the transaction
        timeout: 20_000,
      },
    );

    // the product is written: the files nothing points to any more go; a file that stays only
    // takes space, so a failure goes to the log
    await Promise.all(
      staleFiles.map(async (publicId) => {
        try {
          await deleteImage(publicId);
        } catch (err) {
          log.warn({ err, productId: productIdRaw, publicId }, 'old product image was not removed');
        }
      }),
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
    throw new InternalError({ reason: 'PRODUCTS_UPDATE_UNEXPECTED' }, err);
  }
}

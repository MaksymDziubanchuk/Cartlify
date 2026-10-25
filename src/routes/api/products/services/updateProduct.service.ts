import { expiredUnitsNow } from '@db/expiredStock.helper.js';
import { Prisma } from '@prisma/client';
import { getPgMessage, tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { buildProductUpdateAuditChanges, writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { isSaleOn } from '@helpers/productSale.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import {
  normalizeProductSafety,
  parseProductDescription,
  serializeProductDescription,
} from '@helpers/productDescription.js';
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
  assertCategoryExists,
  discardMovedImages,
  placeProductImages,
  mapProductRowToResponse,
  productResponseSelect,
  readCategoryPath,
  writeProductPriceChangeLog,
  computeFixedDelta,
  readProductImageUrls,
  normalizeFindProductByIdInput,
  normalizeUpdateProductInput,
  normalizeSaleEnd,
  normalizeSku,
  isSkuTaken,
  assertPopularityOverridePair,
  putSaleOn,
  takeSaleOff,
} from './helpers/index.js';

import type { UpdateProductDto, UpdateProductResponseDto } from 'types/dto/products.dto.js';

export async function updateProduct({
  productId,
  actorId,
  actorRole,
  name,
  description,
  sku,
  safety,
  price,
  stock,
  categoryId,
  images,
  popularityOverride,
  popularityOverrideUntil,
  sale,
  log,
}: UpdateProductDto): Promise<UpdateProductResponseDto> {
  // validate actor context for rls and admin-only update
  assertAdminActor(actorId, actorRole);

  // normalize and validate id
  const { productId: productIdRaw } = normalizeFindProductByIdInput({ productId });

  // normalize and validate provided fields; a stock sent is refused, it changes only with a
  // delivery or a write-off
  const {
    nameNorm,
    descriptionNorm,
    priceRaw,
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
  const skuNorm = normalizeSku(sku);
  // the safety data come whole and replace the ones of the product
  const safetyNorm = safety !== undefined ? normalizeProductSafety(safety) : undefined;

  // the word on the sale goes with a price; the sale alone has a route of its own
  if (sale !== undefined && price === undefined) {
    throw new BadRequestError('PRODUCT_SALE_REQUIRES_PRICE');
  }

  // reject empty patch
  const hasImages = Array.isArray(images) && images.length > 0;
  const hasAnyUpdates =
    hasImages ||
    name !== undefined ||
    description !== undefined ||
    safety !== undefined ||
    sku !== undefined ||
    price !== undefined ||
    categoryId !== undefined ||
    popularityOverride !== undefined ||
    popularityOverrideUntil !== undefined;

  if (!hasAnyUpdates) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  // a new sale starts right away, its end is in the future
  const newSaleEndsAt = sale && sale !== 'keep' ? normalizeSaleEnd(sale.endsAt) : undefined;

  // a retried transaction must not move the same upload twice
  const moved = new Map<string, UploadImageResult>();

  try {
    const { after: updated, staleFiles } = await tx(
      async (db) => {
        // set db session context for rls policies
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait to avoid hanging on concurrent updates
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // lock product row to serialize concurrent patches
        await db.$queryRaw`SELECT id FROM cartlify.products WHERE id = ${productIdRaw} FOR UPDATE`;

        // load previous state for audit and price change log
        const before = await db.product.findUnique({
          where: { id: productIdRaw },
          select: {
            id: true,
            name: true,
            description: true,
            sku: true,
            price: true,
            salePrice: true,
            saleEndsAt: true,
            categoryId: true,
            popularityOverride: true,
            popularityOverrideUntil: true,
            popularity: true,
            deletedAt: true,
          },
        });
        if (!before) throw new NotFoundError('PRODUCT_NOT_FOUND');

        // a new sale goes on a product of the catalog only, the same as on the route of the sale
        if (sale && sale !== 'keep' && before.deletedAt)
          throw new NotFoundError('PRODUCT_NOT_FOUND');
        if (categoryId !== undefined) await assertCategoryExists(db, categoryIdRaw!);

        // an override with its end, or neither: a change of one keeps the other one of the
        // product. A change that leaves the override alone is not checked, old rows of dev may
        // have an override without an end
        if (popularityOverride !== undefined || popularityOverrideUntil !== undefined) {
          assertPopularityOverridePair({
            popularityOverride:
              popularityOverride === undefined
                ? before.popularityOverride
                : (popularityOverrideRaw ?? null),
            popularityOverrideUntil:
              popularityOverrideUntil === undefined
                ? before.popularityOverrideUntil
                : (popularityOverrideUntilDate ?? null),
          });
        }

        // a new price of a product with a sale that is on says what happens to the sale: keep it,
        // take it off, or a new one. Each step writes every line of the logs: the old sale off,
        // the price, the new sale from the new price
        const saleOn = isSaleOn(before);
        const newPrice = priceRaw !== undefined ? new Prisma.Decimal(priceRaw) : undefined;
        if (saleOn && newPrice && !newPrice.equals(before.price)) {
          if (sale === undefined) {
            throw new ConflictError('PRODUCT_SALE_DECISION_REQUIRED', {
              salePrice: decimalToNumber(before.salePrice),
              saleEndsAt: before.saleEndsAt!.toISOString(),
            });
          }
          // a sale stays below the price: a price down to it cannot keep it
          if (sale === 'keep' && newPrice.lessThanOrEqualTo(before.salePrice!)) {
            throw new ConflictError('PRODUCT_SALE_NOT_BELOW_PRICE', {
              salePrice: decimalToNumber(before.salePrice),
              price: decimalToNumber(newPrice),
            });
          }
        }

        const saleContext = { db, actorId, actorRole };
        if (saleOn && sale !== undefined && sale !== 'keep') await takeSaleOff(saleContext, before);

        // build update payload only for provided fields
        // the description keeps the text and the safety data: a change of one keeps the other
        const kept = parseProductDescription(before.description);
        const data: Prisma.ProductUpdateInput = {
          ...(name !== undefined ? { name: nameNorm! } : {}),
          ...(description !== undefined || safetyNorm !== undefined
            ? {
                description: serializeProductDescription({
                  text: description !== undefined ? descriptionNorm || null : kept.text,
                  safety: safetyNorm ?? kept.safety,
                }),
              }
            : {}),
          ...(skuNorm !== undefined ? { sku: skuNorm } : {}),
          ...(price !== undefined ? { price: new Prisma.Decimal(priceRaw!) } : {}),
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

        // persist product update under row lock; a price down to the sale price or below ends the
        // sale in the database (db/05), which writes its end in the admin log (PRODUCT_SALE)
        const after = await db.product.update({
          where: { id: productIdRaw },
          data,
          select: productResponseSelect,
        });

        // build diff list for admin audit log
        const auditChanges = buildProductUpdateAuditChanges(before, {
          after,
          input: {
            name,
            description,
            safety,
            sku,
            price,
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

        // the new sale is counted from the new price, after the old one went and the price changed
        const final =
          sale && sale !== 'keep'
            ? await putSaleOn(
                saleContext,
                { id: after.id, price: after.price, salePrice: null, saleEndsAt: null },
                sale,
                newSaleEndsAt!,
              )
            : after;

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

        return { after: final, staleFiles };
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
    const expired = await expiredUnitsNow([updated.id]);

    // map db row into api dto
    return mapProductRowToResponse({
      product: { ...updated, expiredStock: expired.get(updated.id) ?? 0 },
      images: imageRows,
      categoryPath: await readCategoryPath(updated.category.id),
      view: 'admin',
    });
  } catch (err) {
    // the transaction went back: the uploads that moved to the paths of the product before the
    // failure have no row, they go (the ones still waiting go in the controller)
    await discardMovedImages(moved, log);

    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    // one product of the catalog has an article number at a time
    if (isSkuTaken(err)) throw new ConflictError('PRODUCT_SKU_TAKEN');

    // the end just ahead by the clock of the server is already behind by the one of the database:
    // its trigger refuses it the way the route of the sale answers it
    if (String(getPgMessage(err) ?? '').includes('PRODUCT_SALE_ENDS_AT_INVALID')) {
      throw new BadRequestError('PRODUCT_SALE_ENDS_AT_INVALID');
    }

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) {
      throw new ResourceBusyError();
    }
    throw new InternalError({ reason: 'PRODUCTS_UPDATE_UNEXPECTED' }, err);
  }
}

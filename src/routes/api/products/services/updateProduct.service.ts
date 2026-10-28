import { expiredUnitsNow } from '@db/expiredStock.helper.js';
import { lastUnitCostsNow } from '@db/lastUnitCost.helper.js';
import { Prisma } from '@prisma/client';
import { getPgMessage, tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { deleteImage, isOwnFile, type UploadImageResult } from '@utils/cloudinary.util.js';

import {
  BadRequestError,
  ConflictError,
  InternalError,
  isAppError,
  ResourceBusyError,
} from '@utils/errors.js';

import {
  checkProductUpdate,
  discardMovedImages,
  isSkuTaken,
  mapProductRowToResponse,
  normalizeFindProductByIdInput,
  placeProductImages,
  planProductUpdate,
  productBeforeUpdateSelect,
  readCategoryPath,
  readProductImageUrls,
  writeProductUpdate,
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
  weightGrams,
  lengthMm,
  widthMm,
  heightMm,
  withoutShippingData,
  popularityOverride,
  popularityOverrideUntil,
  sale,
  log,
}: UpdateProductDto): Promise<UpdateProductResponseDto> {
  // validate actor context for rls and admin-only update
  assertAdminActor(actorId, actorRole);

  // normalize and validate id
  const { productId: productIdRaw } = normalizeFindProductByIdInput({ productId });
  const hasImages = Array.isArray(images) && images.length > 0;

  // the fields sent, normalized and checked before the transaction
  const plan = planProductUpdate(
    {
      name,
      description,
      sku,
      safety,
      price,
      stock,
      categoryId,
      weightGrams,
      lengthMm,
      widthMm,
      heightMm,
      withoutShippingData,
      popularityOverride,
      popularityOverrideUntil,
      sale,
    },
    { hasImages },
  );

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

        // load previous state for the checks, the audit and the price change log
        const found = await db.product.findUnique({
          where: { id: productIdRaw },
          select: productBeforeUpdateSelect,
        });
        const before = await checkProductUpdate(db, plan, found);

        const final = await writeProductUpdate({ db, actorId, actorRole }, plan, before);

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
    const costs = await lastUnitCostsNow({ actorId, actorRole }, [updated.id]);

    // map db row into api dto
    return mapProductRowToResponse({
      product: {
        ...updated,
        expiredStock: expired.get(updated.id) ?? 0,
        lastUnitCost: costs.get(updated.id) ?? null,
      },
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

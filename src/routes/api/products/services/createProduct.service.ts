import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { BadRequestError, ConflictError, InternalError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import {
  normalizeProductSafety,
  serializeProductDescription,
} from '@helpers/productDescription.js';
import { readShippingChanges, resolveShippingData } from '@helpers/productShipping.js';

import {
  assertCategoryExists,
  discardMovedImages,
  placeProductImages,
  mapProductRowToResponse,
  productResponseSelect,
  readCategoryPath,
  readProductImageUrls,
  normalizeCreateProductInput,
  normalizeSku,
  isSkuTaken,
} from './helpers/index.js';

import type { CreateProductDto, CreateProductResponseDto } from 'types/dto/products.dto.js';
import type { AuditChange } from '@db/adminAudit.helper.js';
import type { UploadImageResult } from '@utils/cloudinary.util.js';

export async function createProduct({
  actorId,
  actorRole,
  productId,
  name,
  description,
  sku,
  safety,
  price,
  categoryId,
  images,
  stock,
  weightGrams,
  lengthMm,
  widthMm,
  heightMm,
  withoutShippingData,
  log,
}: CreateProductDto): Promise<CreateProductResponseDto> {
  // validate actor context for rls and admin-only create
  assertAdminActor(actorId, actorRole);

  // normalize and validate required scalar fields
  // a stock sent is refused: a new product has none, it comes with a delivery
  const { nameNorm, descriptionNorm, priceRaw, categoryIdRaw } = normalizeCreateProductInput({
    name,
    description,
    price,
    categoryId,
    stock,
  });
  const skuNorm = normalizeSku(sku) ?? null;
  // a new product names its manufacturer and who answers for it in the EU (GPSR)
  const safetyNorm = normalizeProductSafety(safety);
  // and its weight and sizes, unless the admin says they come later
  const { changes, without } = readShippingChanges({
    weightGrams,
    lengthMm,
    widthMm,
    heightMm,
    withoutShippingData,
  });
  const shipping = resolveShippingData(null, changes, without);

  // reject invalid payload when controller sent no uploads
  if (!Array.isArray(images) || images.length === 0) {
    throw new BadRequestError('PRODUCT_IMAGES_REQUIRED');
  }

  // prepare audit changes list for create
  const auditChanges: AuditChange[] = [
    { field: 'name', old: null, new: nameNorm },
    { field: 'description', old: null, new: descriptionNorm ?? null },
    { field: 'safety', old: null, new: safetyNorm },
    ...(skuNorm ? [{ field: 'sku', old: null, new: skuNorm }] : []),
    { field: 'price', old: null, new: priceRaw },
    { field: 'categoryId', old: null, new: categoryIdRaw },
    ...Object.entries(shipping)
      .filter(([, value]) => value !== null)
      .map(([field, value]) => ({ field, old: null, new: value })),
  ];

  // the uploads that moved to the paths of the product, for a failure after some of them
  const moved = new Map<string, UploadImageResult>();

  try {
    // create product row, log admin action and place the images in one tx
    const created = await prisma.$transaction(
      async (tx) => {
        // set db session context for rls policies
        await setUserContext(tx, { userId: actorId, role: actorRole });

        await assertCategoryExists(tx, categoryIdRaw);

        // create product row with reserved id from controller flow
        const product = await tx.product.create({
          data: {
            id: productId,
            name: nameNorm,
            // the text and the safety data in one column
            description: serializeProductDescription({
              text: descriptionNorm ?? null,
              safety: safetyNorm,
            }),
            sku: skuNorm,
            price: new Prisma.Decimal(priceRaw),
            categoryId: categoryIdRaw,
            ...shipping,
          },
          select: productResponseSelect,
        });

        // write admin audit log for product create
        await writeAdminAuditLog(tx, {
          actorId,
          actorRole,
          entityType: 'product',
          entityId: product.id,
          action: 'PRODUCT_CREATE',
          event: 'product.create',
          changes: auditChanges,
        });

        // the uploads move to the paths of the product last, once every row is written
        await placeProductImages({ tx, productId: product.id, uploads: images, moved });

        return product;
        // the moves at cloudinary run inside the transaction
      },
      { timeout: 20_000 },
    );

    // fetch all product images and map urls
    const imageRows = await readProductImageUrls(created.id);

    // map db row into api dto
    // a new product has no batch yet, so nothing of it is over
    return mapProductRowToResponse({
      product: { ...created, expiredStock: 0 },
      images: imageRows,
      categoryPath: await readCategoryPath(created.category.id),
      view: 'admin',
    });
  } catch (err) {
    // the uploads that moved before the failure have no row, they go
    await discardMovedImages(moved, log);

    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    // one product of the catalog has an article number at a time
    if (isSkuTaken(err)) throw new ConflictError('PRODUCT_SKU_TAKEN');

    throw new InternalError({ reason: 'PRODUCTS_CREATE_UNEXPECTED' }, err);
  }
}

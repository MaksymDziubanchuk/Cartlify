import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { AppError, BadRequestError, isAppError } from '@utils/errors.js';

import {
  normalizeMultipartFiles,
  uploadProductImages,
  persistProductImages,
  mapProductRowToResponse,
  writeAdminAuditLog,
  readProductImageUrls,
  assertAdminActor,
  normalizeCreateProductInput,
} from './helpers/index.js';

import type { CreateProductDto, CreateProductResponseDto } from 'types/dto/products.dto.js';
import type { AuditChange } from './helpers/index.js';

export async function createProduct({
  actorId,
  actorRole,
  name,
  description,
  price,
  categoryId,
  images,
  stock,
}: CreateProductDto): Promise<CreateProductResponseDto> {
  // validate actor context for rls and admin-only create
  assertAdminActor(actorId, actorRole);

  // unwrap and validate required scalar fields
  const { nameNorm, descriptionNorm, priceRaw, categoryIdRaw, stockNorm } =
    normalizeCreateProductInput({
      name,
      description,
      price,
      categoryId,
      stock,
    });

  // normalize multipart images into file parts for upload
  const imageParts = normalizeMultipartFiles(images);

  // reject invalid payload (images required)
  if (!imageParts.length) throw new BadRequestError('PRODUCT_IMAGES_REQUIRED');

  // prepare audit changes list for create
  const auditChanges: AuditChange[] = [
    { field: 'name', old: null, new: nameNorm },
    { field: 'description', old: null, new: descriptionNorm ?? null },
    { field: 'price', old: null, new: priceRaw },
    { field: 'stock', old: null, new: stockNorm },
    { field: 'categoryId', old: null, new: categoryIdRaw },
  ];

  try {
    // create product row and log admin action in same tx
    const created = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const product = await tx.product.create({
        data: {
          name: nameNorm,
          description: descriptionNorm ? descriptionNorm : null,
          price: new Prisma.Decimal(priceRaw),
          stock: stockNorm,
          categoryId: categoryIdRaw,
        },
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

      // write admin audit log for product create
      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'product',
        entityId: product.id,
        action: 'PRODUCT_CREATE',
        changes: auditChanges,
      });

      return product;
    });

    // upload images outside tx to avoid external calls inside db transaction
    const uploads = await uploadProductImages({ productId: created.id, imageParts });

    await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // persist uploaded image pointers
      await persistProductImages({ tx, productId: created.id, uploads });
    });

    // fetch all product images and map urls
    const images = await readProductImageUrls(created.id);

    // map db row into api dto
    return mapProductRowToResponse({
      product: created,
      images,
    });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`products.createProduct: unexpected (${msg})`, 500);
  }
}

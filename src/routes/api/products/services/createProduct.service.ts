import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { AppError, BadRequestError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import {
  persistProductImages,
  mapProductRowToResponse,
  readProductImageUrls,
  normalizeCreateProductInput,
} from './helpers/index.js';

import type { CreateProductDto, CreateProductResponseDto } from 'types/dto/products.dto.js';
import type { AuditChange } from '@db/adminAudit.helper.js';

export async function createProduct({
  actorId,
  actorRole,
  productId,
  name,
  description,
  price,
  categoryId,
  images,
  stock,
}: CreateProductDto): Promise<CreateProductResponseDto> {
  // validate actor context for rls and admin-only create
  assertAdminActor(actorId, actorRole);

  // normalize and validate required scalar fields
  const { nameNorm, descriptionNorm, priceRaw, categoryIdRaw, stockNorm } =
    normalizeCreateProductInput({
      name,
      description,
      price,
      categoryId,
      stock,
    });

  // reject invalid payload when controller sent no uploads
  if (!Array.isArray(images) || images.length === 0) {
    throw new BadRequestError('PRODUCT_IMAGES_REQUIRED');
  }

  // prepare audit changes list for create
  const auditChanges: AuditChange[] = [
    { field: 'name', old: null, new: nameNorm },
    { field: 'description', old: null, new: descriptionNorm ?? null },
    { field: 'price', old: null, new: priceRaw },
    { field: 'stock', old: null, new: stockNorm },
    { field: 'categoryId', old: null, new: categoryIdRaw },
  ];

  try {
    // create product row, persist images, and log admin action in one tx
    const created = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // create product row with reserved id from controller flow
      const product = await tx.product.create({
        data: {
          id: productId,
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

      // persist uploaded image pointers in db
      await persistProductImages({
        tx,
        productId: product.id,
        uploads: images,
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

    // fetch all product images and map urls
    const imageRows = await readProductImageUrls(created.id);

    // map db row into api dto
    return mapProductRowToResponse({
      product: created,
      images: imageRows,
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

import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { AppError, BadRequestError, ForbiddenError, isAppError } from '@utils/errors.js';

import { toNumberSafe, toStringSafe } from '@helpers/safeNormalizer.js';
import {
  normalizeMultipartFiles,
  uploadProductImages,
  persistProductImages,
  mapProductRowToResponse,
  writeAdminAuditLog,
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
}: CreateProductDto): Promise<CreateProductResponseDto> {
  // validate actor context for rls and admin-only create
  if (!Number.isInteger(actorId)) throw new ForbiddenError('ACTOR_ID_INVALID');
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN');

  // unwrap and validate required scalar fields
  const nameRaw = toStringSafe(name);
  const descriptionRaw = description != null ? toStringSafe(description) : undefined;
  const priceRaw = toNumberSafe(price);
  const categoryIdRaw = toNumberSafe(categoryId);

  const nameNorm = (nameRaw ?? '').trim();
  if (!nameNorm) throw new BadRequestError('PRODUCT_NAME_REQUIRED');

  if (priceRaw == null || !Number.isFinite(priceRaw) || priceRaw < 0) {
    throw new BadRequestError('PRODUCT_PRICE_INVALID');
  }

  if (categoryIdRaw == null || !Number.isInteger(categoryIdRaw) || categoryIdRaw <= 0) {
    throw new BadRequestError('CATEGORY_ID_INVALID');
  }

  const descriptionNorm = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : undefined;

  // normalize multipart images into file parts for upload
  const imageParts = normalizeMultipartFiles(images);

  // prepare audit changes list for create
  const auditChanges: AuditChange[] = [
    { field: 'name', old: null, new: nameNorm },
    { field: 'description', old: null, new: descriptionNorm ?? null },
    { field: 'price', old: null, new: priceRaw },
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
          categoryId: categoryIdRaw,
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
    if (imageParts.length) {
      const uploads = await uploadProductImages({ productId: created.id, imageParts });

      await prisma.$transaction(async (tx) => {
        // set db session context for rls policies
        await setUserContext(tx, { userId: actorId, role: actorRole });

        // persist uploaded image pointers
        await persistProductImages({ tx, productId: created.id, uploads });
      });
    }

    // fetch primary image url for response mapping
    const primary = await prisma.productImage.findFirst({
      where: { productId: created.id, isPrimary: true },
      select: { url: true },
      orderBy: { position: 'asc' },
    });

    // map db row into api dto
    return mapProductRowToResponse({
      product: created,
      ...(primary?.url ? { primaryImageUrl: primary.url } : {}),
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

import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { BadRequestError, InternalError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import {
  placeProductImages,
  mapProductRowToResponse,
  productResponseSelect,
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
  // a stock sent is refused: a new product has none, it comes with a delivery
  const { nameNorm, descriptionNorm, priceRaw, categoryIdRaw } = normalizeCreateProductInput({
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
    { field: 'categoryId', old: null, new: categoryIdRaw },
  ];

  try {
    // create product row, log admin action and place the images in one tx
    const created = await prisma.$transaction(
      async (tx) => {
        // set db session context for rls policies
        await setUserContext(tx, { userId: actorId, role: actorRole });

        // create product row with reserved id from controller flow
        const product = await tx.product.create({
          data: {
            id: productId,
            name: nameNorm,
            description: descriptionNorm ? descriptionNorm : null,
            price: new Prisma.Decimal(priceRaw),
            categoryId: categoryIdRaw,
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
          changes: auditChanges,
        });

        // the uploads move to the paths of the product last, once every row is written
        await placeProductImages({ tx, productId: product.id, uploads: images, moved: new Map() });

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
      view: 'admin',
    });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_CREATE_UNEXPECTED' }, err);
  }
}

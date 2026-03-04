import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';

import { InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import { mapProductRowToResponse, normalizeFindProductByIdInput } from './helpers/index.js';

import type { FullProductResponseDto, FindProductByIdDto } from 'types/dto/products.dto.js';

export async function findById(dto: FindProductByIdDto): Promise<FullProductResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);

  try {
    const { product, images } = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setActorContext(tx, { actorId: dto.actorId, role: dto.actorRole });

      // ensure product exists for 404
      const exists = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundError('PRODUCT_NOT_FOUND');

      // increment views and return updated row
      const product = await tx.product.update({
        where: { id: productId },
        data: { views: { increment: 1 } },
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          stock: true,
          reservedStock: true,
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

      // load images for response mapping
      const imageRows = await tx.productImage.findMany({
        where: { productId: productId },
        select: { url: true, position: true },
        orderBy: { position: 'asc' },
      });

      // reject invalid db state (product has no images)
      if (!imageRows.length) throw new InternalError({ reason: 'PRODUCT_IMAGES_NOT_FOUND' });

      return { product, images: imageRows };
    });

    // map db row into api dto
    return mapProductRowToResponse({ product, images });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_FIND_BY_ID_UNEXPECTED' }, err);
  }
}

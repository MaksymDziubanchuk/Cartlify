import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';

import { InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import {
  mapProductRowToResponse,
  normalizeFindProductByIdInput,
  productResponseSelect,
  productViewOf,
} from './helpers/index.js';

import type { FullProductResponseDto, FindProductByIdDto } from 'types/dto/products.dto.js';

// the card of a product page, as a buyer or as an admin sees it (productViewOf)
export async function findById(dto: FindProductByIdDto): Promise<FullProductResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);
  const view = productViewOf(dto.actorRole);

  try {
    const { product, images } = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setActorContext(tx, { actorId: dto.actorId, role: dto.actorRole });

      // ensure product exists for 404; a deleted product exists only for admin and root
      const exists = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, deletedAt: true },
      });
      if (!exists || (exists.deletedAt && view !== 'admin')) {
        throw new NotFoundError('PRODUCT_NOT_FOUND');
      }

      // a visit of a buyer is a view of the product, the one of an admin is not
      const product =
        view === 'admin'
          ? await tx.product.findUniqueOrThrow({
              where: { id: productId },
              select: productResponseSelect,
            })
          : await tx.product.update({
              where: { id: productId },
              data: { views: { increment: 1 } },
              select: productResponseSelect,
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
    return mapProductRowToResponse({ product, images, view });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_FIND_BY_ID_UNEXPECTED' }, err);
  }
}

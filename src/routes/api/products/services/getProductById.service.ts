import { expiredUnitsOf } from '@db/expiredStock.helper.js';
import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';

import { InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import {
  mapProductRowToResponse,
  normalizeFindProductByIdInput,
  productResponseSelect,
  productViewOf,
  readCategoryPath,
} from './helpers/index.js';

import type { FullProductResponseDto, FindProductByIdDto } from 'types/dto/products.dto.js';

// the card of a product page, as a buyer or as an admin sees it (productViewOf)
export async function findById(dto: FindProductByIdDto): Promise<FullProductResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);
  const view = productViewOf(dto.actorRole);

  try {
    const { product, images, categoryPath } = await prisma.$transaction(async (tx) => {
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

      // a visit of a buyer is a view of the product, the one of an admin is not. A plain update of
      // the counter: prisma would set updatedAt too, and the last change of a product is a change
      // an admin made
      if (view !== 'admin') {
        await tx.$executeRaw`
          update cartlify.products set views = views + 1 where id = ${productId}::int
        `;
      }

      const product = await tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: productResponseSelect,
      });

      // load images for response mapping; a product without one opens by its id with none, the
      // lists of a buyer leave it out
      const imageRows = await tx.productImage.findMany({
        where: { productId: productId },
        select: { url: true, position: true },
        orderBy: { position: 'asc' },
      });

      // the free units leave out the units of batches that are over
      const expired = await expiredUnitsOf(tx, [productId]);

      return {
        product: { ...product, expiredStock: expired.get(productId) ?? 0 },
        images: imageRows,
        categoryPath: await readCategoryPath(product.category.id, tx),
      };
    });

    // map db row into api dto
    return mapProductRowToResponse({ product, images, categoryPath, view });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_FIND_BY_ID_UNEXPECTED' }, err);
  }
}

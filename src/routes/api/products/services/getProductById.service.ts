import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';

import { InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import {
  buildProductCard,
  normalizeFindProductByIdInput,
  productViewOf,
  readVariantContext,
  variantFullOf,
  variantRowSelect,
  visibleVariantWhere,
} from './helpers/index.js';

import type { FullProductResponseDto, FindProductByIdDto } from 'types/dto/products.dto.js';
import type { GetVariantDto, GetVariantResponseDto } from 'types/dto/variants.dto.js';

// the card of a product page, as a buyer or as an admin sees it (productViewOf, buildProductCard):
// the product, the variant it opens (the one asked for, or the main one) and the variants to
// switch between. The visit of a buyer is a view of the product
export async function findById(dto: FindProductByIdDto): Promise<FullProductResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);
  const view = productViewOf(dto.actorRole);

  try {
    return await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setActorContext(tx, { actorId: dto.actorId, role: dto.actorRole });

      return buildProductCard(tx, {
        productId,
        view,
        ...(dto.variantId !== undefined ? { variantId: dto.variantId } : {}),
        countView: true,
      });
    });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_FIND_BY_ID_UNEXPECTED' }, err);
  }
}

// one variant of a product on its own, without the product: a buyer gets a variant that is for sale
// and shows a picture of a product that is there, an admin any. It is no view of the product
export async function findVariant(dto: GetVariantDto): Promise<GetVariantResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);
  const view = productViewOf(dto.actorRole);

  try {
    return await prisma.$transaction(async (tx) => {
      await setActorContext(tx, { actorId: dto.actorId, role: dto.actorRole });

      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, deletedAt: true },
      });
      if (!product || (product.deletedAt && view !== 'admin')) {
        throw new NotFoundError('PRODUCT_NOT_FOUND');
      }

      const row = await tx.productVariant.findFirst({
        where: {
          id: dto.variantId,
          productId,
          ...(view === 'buyer' ? visibleVariantWhere : {}),
        },
        select: variantRowSelect,
      });
      if (!row) throw new NotFoundError('VARIANT_NOT_FOUND');

      const context = await readVariantContext(tx, [row], view, { full: true });
      return variantFullOf(row, context, view);
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_FIND_VARIANT_UNEXPECTED' }, err);
  }
}

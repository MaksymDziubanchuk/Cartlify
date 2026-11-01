import { inAdminTx } from '@routes/api/attributes/services/helpers/directory.helper.js';
import { ConflictError, NotFoundError } from '@utils/errors.js';

import {
  knownVariantDbError,
  lockVariantOfProduct,
  logVariant,
  normalizeFindProductByIdInput,
} from './helpers/index.js';

import type { DeleteVariantDto, DeleteVariantResponseDto } from 'types/dto/variants.dto.js';

// DELETE /api/products/:productId/variants/:variantId: takes the variant out of sale. It is only
// marked (deletedAt): a buyer does not see it, the orders, the carts and the batches keep it, it
// lets its article number and barcode go, and it holds its place among the variants. An admin
// puts it back with the restore route. A variant that is out of sale already is 409
// VARIANT_ALREADY_DELETED (the variants of a product that was removed are)
export async function deleteVariant(dto: DeleteVariantDto): Promise<DeleteVariantResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);
  const { variantId } = dto;
  const actor = { actorId: dto.actorId, actorRole: dto.actorRole };

  return inAdminTx(
    actor,
    'VARIANT_DELETE_UNEXPECTED',
    async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');

      // the row is locked, then read: two deletes of one variant act once, the other finds it out
      // of sale already
      if (!(await lockVariantOfProduct(tx, productId, variantId))) {
        throw new NotFoundError('VARIANT_NOT_FOUND');
      }
      const before = await tx.productVariant.findFirstOrThrow({
        where: { id: variantId, productId },
        select: { id: true, deletedAt: true },
      });
      if (before.deletedAt) throw new ConflictError('VARIANT_ALREADY_DELETED');

      const after = await tx.productVariant.update({
        where: { id: variantId },
        data: { deletedAt: new Date() },
        select: { id: true, deletedAt: true },
      });
      const deletedAt = after.deletedAt!.toISOString();

      await logVariant(tx, actor, {
        event: 'variant.delete',
        variantId,
        changes: [{ field: 'deletedAt', old: null, new: deletedAt }],
      });

      return { id: after.id, deletedAt };
    },
    knownVariantDbError,
  );
}

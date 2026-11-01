import { getPgMessage } from '@db/client.js';
import { inAdminTx } from '@routes/api/attributes/services/helpers/directory.helper.js';
import { ConflictError, NotFoundError } from '@utils/errors.js';

import {
  assertCodesFree,
  assertValuesAccepted,
  knownVariantDbError,
  lockProduct,
  lockVariantOfProduct,
  logVariant,
  mapProductPart,
  normalizeFindProductByIdInput,
  productResponseSelect,
  readVariantContext,
  variantFullOf,
  variantRowSelect,
} from './helpers/index.js';

import type { RestoreVariantDto, RestoreVariantResponseDto } from 'types/dto/variants.dto.js';

// POST /api/products/:productId/variants/:variantId/restore: puts a variant that was taken out of
// sale back. A variant that is for sale is 409 VARIANT_NOT_DELETED; the variant of a product that is
// removed is not brought back alone, the product comes first (409 PRODUCT_DELETED, the database
// refuses it too); its article number or barcode taken by another live variant meanwhile is 409
// PRODUCT_SKU_TAKEN or VARIANT_BARCODE_TAKEN
export async function restoreVariant(dto: RestoreVariantDto): Promise<RestoreVariantResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);
  const { variantId } = dto;
  const actor = { actorId: dto.actorId, actorRole: dto.actorRole };

  return inAdminTx(
    actor,
    'VARIANT_RESTORE_UNEXPECTED',
    async (tx) => {
      // The row of the product first: a variant must not come back under a product whose delete is
      // in flight (that delete takes only the variants that are for sale when it runs), and the
      // product is read after the wait. Then the row of the variant: two restores of one variant act
      // once, the other finds it for sale already
      await lockProduct(tx, productId);
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: productResponseSelect,
      });
      if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');

      if (!(await lockVariantOfProduct(tx, productId, variantId))) {
        throw new NotFoundError('VARIANT_NOT_FOUND');
      }
      const before = await tx.productVariant.findFirstOrThrow({
        where: { id: variantId, productId },
        select: { id: true, sku: true, barcode: true, deletedAt: true },
      });
      if (!before.deletedAt) throw new ConflictError('VARIANT_NOT_DELETED');
      if (product.deletedAt) throw new ConflictError('PRODUCT_DELETED');

      await assertCodesFree(tx, [{ sku: before.sku, barcode: before.barcode }], {
        ignoreVariantId: variantId,
        single: true,
      });

      await tx.productVariant.update({ where: { id: variantId }, data: { deletedAt: null } });

      // a variant that comes back must not repeat the values of a live one (the row of the product
      // is locked, so no request makes one meanwhile)
      await assertValuesAccepted(
        tx,
        [{ variantId, productId, categoryId: product.categoryId, ref: { variantId } }],
        { required: false, single: true },
      );
      await logVariant(tx, actor, {
        event: 'variant.restore',
        variantId,
        changes: [{ field: 'deletedAt', old: before.deletedAt.toISOString(), new: null }],
      });

      const row = await tx.productVariant.findUniqueOrThrow({
        where: { id: variantId },
        select: variantRowSelect,
      });
      const context = await readVariantContext(tx, [row], 'admin', { full: true });

      return {
        product: mapProductPart(product, 'admin'),
        variant: variantFullOf(row, context, 'admin'),
      };
    },
    async (err) => {
      // the product was removed between the read and the write: the guard of db/05 refuses
      if (String(getPgMessage(err) ?? '').includes('VARIANT_UPDATE_FORBIDDEN')) {
        return new ConflictError('PRODUCT_DELETED');
      }

      return knownVariantDbError(err);
    },
  );
}

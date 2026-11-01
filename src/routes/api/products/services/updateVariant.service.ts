import { inAdminTx } from '@routes/api/attributes/services/helpers/directory.helper.js';
import { NotFoundError, isAppError } from '@utils/errors.js';

import {
  assertCodesFree,
  assertGalleryImages,
  assertValuesAccepted,
  checkVariantChange,
  codeWritesOf,
  imagesChangeOf,
  knownVariantDbError,
  loadValueContext,
  lockProduct,
  mapProductPart,
  moveVariant,
  normalizeFindProductByIdInput,
  planVariantUpdate,
  productResponseSelect,
  readHeldValues,
  readVariantContext,
  resolveValues,
  variantFullOf,
  variantRowSelect,
  withVariant,
  writeVariantChange,
  writeVariantImages,
  type VariantValuesToWrite,
} from './helpers/index.js';

import type { UpdateVariantDto, UpdateVariantResponseDto } from 'types/dto/variants.dto.js';

// PATCH /api/products/:productId/variants/:variantId: what is sent changes, the rest stays: the
// article number, the barcode, the weight and the sizes (the rules of a product's shipping data),
// the price with the word on its sale (the sale that is on is kept, taken off or replaced, each
// step with every line of the logs), the place among the variants (the others move around it), the
// pictures (written whole), the values of the characteristics that are named (null takes one away;
// the required ones of the category must stay, and no other variant of the product may have the
// same values: 409 VARIANT_DUPLICATE). The line of the admin log (variant.update) names the fields
// that changed
export async function updateVariant(dto: UpdateVariantDto): Promise<UpdateVariantResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);
  const { variantId } = dto;
  const actor = { actorId: dto.actorId, actorRole: dto.actorRole };

  const plan = planVariantUpdate(dto);

  return inAdminTx(
    actor,
    'VARIANT_UPDATE_UNEXPECTED',
    async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: productResponseSelect,
      });
      if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');

      // a move renumbers the other variants of the product, and new values may make the variant
      // repeat another: either waits for the requests that make, move or change variants of this
      // product
      if (plan.position !== undefined || plan.attributes) await lockProduct(tx, productId);

      // the row is locked until the end: two changes of one variant wait for each other
      await tx.$queryRaw`select id from cartlify.product_variants where id = ${variantId}::int and "productId" = ${productId}::int for update`;
      const before = await tx.productVariant.findFirst({
        where: { id: variantId, productId },
        select: variantRowSelect,
      });
      if (!before) throw new NotFoundError('VARIANT_NOT_FOUND');

      // the sizes stay all three or none, the word on the sale fits the price
      checkVariantChange(before, product, plan);

      // the values of the characteristics, each against the directory, before anything is written
      let values: VariantValuesToWrite | undefined;
      if (plan.attributes) {
        const valueCtx = await loadValueContext(tx, plan.attributes);
        try {
          values = {
            held: (await readHeldValues(tx, [variantId])).get(variantId) ?? new Map(),
            resolved: resolveValues(valueCtx, plan.attributes, { allowRemove: true }),
          };
        } catch (err) {
          throw isAppError(err) ? withVariant(err, { variantId }) : err;
        }
      }

      // a code that changes must be free; a variant that is out of sale holds none (db/06), the
      // check comes when it is put back
      const codes = codeWritesOf(before, plan);

      if (before.deletedAt === null && (codes.sku || codes.barcode)) {
        await assertCodesFree(tx, [{ sku: codes.sku ?? null, barcode: codes.barcode ?? null }], {
          ignoreVariantId: variantId,
          single: true,
        });
      }

      const { valueChanges } = await writeVariantChange({ db: tx, ...actor }, before, plan, {
        data: codes.data,
        changes: codes.changes,
        ...(values ? { values } : {}),
        // the place and the pictures come after the row is written, before the line of the admin log
        more: async (changes) => {
          if (plan.position !== undefined && plan.position !== before.position) {
            await moveVariant(tx, productId, variantId, plan.position);
            const after = await tx.productVariant.findUniqueOrThrow({
              where: { id: variantId },
              select: { position: true },
            });
            changes.push({ field: 'position', old: before.position, new: after.position });
          }

          const pictures = plan.images && imagesChangeOf(before, plan.images);
          if (pictures) {
            await assertGalleryImages(
              tx,
              productId,
              pictures.next.map((image) => image.imageId),
            );
            await writeVariantImages(tx, variantId, pictures.next);
            changes.push({ field: 'images', old: pictures.old, new: pictures.next });
          }
        },
      });

      // the values were written: the category's required characteristics are all there, and no other
      // variant of the product has the same values
      if (valueChanges.length) {
        await assertValuesAccepted(
          tx,
          [{ variantId, productId, categoryId: product.categoryId, ref: { variantId } }],
          { required: true, single: true },
        );
      }

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
    knownVariantDbError,
  );
}

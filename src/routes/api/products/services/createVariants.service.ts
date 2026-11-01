import { MAX_PRODUCT_VARIANTS } from '@config/limits.js';
import { inAdminTx } from '@routes/api/attributes/services/helpers/directory.helper.js';
import { BadRequestError, ConflictError } from '@utils/errors.js';

import {
  assertCodesFree,
  assertGalleryImagesOfVariants,
  assertValuesAccepted,
  imageRefsOf,
  knownVariantDbError,
  loadValueContext,
  lockProductThere,
  logVariant,
  newVariantChanges,
  normalizeFindProductByIdInput,
  planNewVariants,
  readVariantContext,
  repeatedCodes,
  resolveNewVariants,
  variantFullOf,
  variantRowSelect,
  VARIANTS_PER_REQUEST_MAX,
  writeValues,
  type TouchedVariant,
} from './helpers/index.js';

import type { CreateVariantsDto, CreateVariantsResponseDto } from 'types/dto/variants.dto.js';

// POST /api/products/:productId/variants: one to VARIANTS_PER_REQUEST_MAX variants more for a
// product that is there, all of them or none. Each shows pictures of the gallery of the product
// (imageId) and takes the next place after the variants the product has; a variant that is wrong
// is named with its error among the others (400 VARIANTS_INVALID), a code that is taken is 409
export async function createVariants(dto: CreateVariantsDto): Promise<CreateVariantsResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);
  const actor = { actorId: dto.actorId, actorRole: dto.actorRole };

  const plans = planNewVariants(
    dto.variants,
    { kind: 'gallery' },
    { perRequest: VARIANTS_PER_REQUEST_MAX },
  );

  return inAdminTx(
    actor,
    'VARIANTS_CREATE_UNEXPECTED',
    async (tx) => {
      // the product is read after its row is locked: a delete that was ahead of this request is
      // seen, one that comes after waits for the end of it and takes the new variants with it
      const product = await lockProductThere(tx, productId);
      // a product that is removed does not get a variant that is for sale
      if (product.deletedAt) throw new ConflictError('PRODUCT_DELETED');

      // the variants the product has, the ones taken out of sale too, hold their places
      const have = await tx.productVariant.count({ where: { productId } });
      if (have + plans.length > MAX_PRODUCT_VARIANTS) {
        throw new BadRequestError('PRODUCT_VARIANTS_TOO_MANY', { max: MAX_PRODUCT_VARIANTS, have });
      }

      await assertGalleryImagesOfVariants(tx, productId, plans);
      await assertCodesFree(tx, plans, { repeated: repeatedCodes(plans) });

      // the values of the characteristics, each against the directory (read and kept as it is until
      // the end), before anything is written
      const valueCtx = await loadValueContext(
        tx,
        plans.flatMap((plan) => plan.attributes),
      );
      const resolved = resolveNewVariants(valueCtx, plans);

      const last = await tx.productVariant.aggregate({
        where: { productId },
        _max: { position: true },
      });
      let position = last._max.position ?? 0;

      const ids: number[] = [];
      const touched: TouchedVariant[] = [];
      for (const [index, plan] of plans.entries()) {
        position += 1;

        const created = await tx.productVariant.create({
          data: {
            productId,
            position,
            price: plan.price,
            sku: plan.sku,
            barcode: plan.barcode,
            ...plan.shipping,
            images: {
              create: imageRefsOf(plan.images).map((image) => ({
                imageId: image.imageId,
                position: image.position,
              })),
            },
          },
          select: { id: true },
        });
        ids.push(created.id);

        const valueChanges = await writeValues(tx, created.id, new Map(), resolved[index]!);
        touched.push({
          variantId: created.id,
          productId,
          categoryId: product.categoryId,
          ref: { index },
        });

        await logVariant(tx, actor, {
          event: 'variant.create',
          variantId: created.id,
          changes: [
            ...newVariantChanges(productId, position, plan, imageRefsOf(plan.images)),
            ...valueChanges,
          ],
        });
      }

      // the category asks for its required characteristics, and no variant repeats another
      await assertValuesAccepted(tx, touched, { required: true });

      const rows = await tx.productVariant.findMany({
        where: { id: { in: ids } },
        select: variantRowSelect,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ordered = ids.map((id) => byId.get(id)!);
      const context = await readVariantContext(tx, ordered, 'admin', { full: true });

      return { variants: ordered.map((row) => variantFullOf(row, context, 'admin')) };
    },
    knownVariantDbError,
    // up to 100 variants, each with its pictures, values and lines of the log
    { timeout: 30_000 },
  );
}

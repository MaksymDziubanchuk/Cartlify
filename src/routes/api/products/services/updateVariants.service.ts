import { NotFoundError } from '@utils/errors.js';

import {
  assertGalleryImages,
  assertValuesAccepted,
  checkEveryVariant,
  checkVariantChange,
  imagesChangeOf,
  loadValueContext,
  lockProduct,
  normalizeFindProductByIdInput,
  planVariantsChange,
  productResponseSelect,
  readHeldValues,
  readVariantContext,
  resolveValues,
  variantFullOf,
  variantRowSelect,
  writeVariantChange,
  writeVariantImages,
  type TouchedVariant,
} from './helpers/index.js';
import { inVariantTx, lockVariants } from './helpers/variantTx.helper.js';
import { refuseWrite } from './helpers/variantsBatch.helper.js';

import type { AuditChange } from '@db/adminAudit.helper.js';
import type { UpdateVariantsDto, UpdateVariantsResponseDto } from 'types/dto/variants.dto.js';

// PATCH /api/products/:productId/variants: the same change for several variants of a product: the
// price with the word on the sale, the weight and the sizes, the pictures. The variants are the ones
// named (variantIds, any of the product, the ones taken out of sale too), or every one for sale.
// Each variant gets the change of PATCH of one variant with its lines of the logs (the events are
// the ones of a request of many); all of them or none, a refusal names every variant refused
// (VARIANTS_INVALID, details.variants). The values of characteristics named in `attributes` are set
// in every one of the variants (null takes one away): each variant is checked on its own, the
// required characteristics of the category stay, and no variant of the product ends up with the
// values of another (409 VARIANT_DUPLICATE). The pictures (`images`) are one list for every variant,
// written whole to each (an empty list takes them all away): the list is checked once against the
// gallery of the product (400 VARIANT_IMAGE_NOT_FOUND, no variant is named: it is the list that is
// wrong), and a variant that shows these pictures already gets no write and no line. The article
// number, the barcode and the place are not here: a code is unique, a place is one variant's. The
// answer has the variants in full, as an admin sees them
export async function updateVariants(dto: UpdateVariantsDto): Promise<UpdateVariantsResponseDto> {
  const { productId } = normalizeFindProductByIdInput(dto);
  const actor = { actorId: dto.actorId, actorRole: dto.actorRole };
  const named = dto.variantIds;

  const plan = planVariantsChange(dto);

  return inVariantTx(actor, 'VARIANTS_UPDATE_UNEXPECTED', async (db) => {
    const product = await db.product.findUnique({
      where: { id: productId },
      select: productResponseSelect,
    });
    if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');
    // without names the change goes to the variants for sale, and a product that is out has none
    if (!named && product.deletedAt) throw new NotFoundError('PRODUCT_NOT_FOUND');

    // the variants of the change: the ones named, in their order, or every one for sale by its place
    const there = await db.productVariant.findMany({
      where: { productId, ...(named ? { id: { in: named } } : { deletedAt: null }) },
      select: { id: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    const found = new Set(there.map((row) => row.id));
    const missing = (named ?? []).filter((id) => !found.has(id));
    if (missing.length) throw new NotFoundError('VARIANT_NOT_FOUND', { variantIds: missing });
    if (!there.length) throw new NotFoundError('VARIANT_NOT_FOUND');

    // new values may make a variant repeat another: the requests that change the variants of this
    // product wait for each other, the row of the product first
    if (plan.attributes) await lockProduct(db, productId);

    // the rows are locked by id, then read as they are
    await lockVariants(db, [...found]);
    const rows = await db.productVariant.findMany({
      where: { id: { in: [...found] } },
      select: variantRowSelect,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const targets = (named ?? there.map((row) => row.id)).map((id) => byId.get(id)!);

    // the pictures of the list are pictures of the gallery of the product, locked until the end (after
    // the rows of the variants): checked once for all of the variants, when one of them changes
    if (plan.images?.length && targets.some((row) => imagesChangeOf(row, plan.images!))) {
      await assertGalleryImages(
        db,
        productId,
        plan.images.map((image) => image.key),
      );
    }

    // the values of the characteristics, each against the directory (read and kept as it is until
    // the end); a variant is checked with its change, the problems of all of them come at once
    const valueCtx = plan.attributes ? await loadValueContext(db, plan.attributes) : undefined;
    const held = plan.attributes
      ? await readHeldValues(
          db,
          targets.map((row) => row.id),
        )
      : new Map();
    const resolved = await checkEveryVariant(
      targets,
      (row) => row.id,
      (row) => {
        checkVariantChange(row, product, plan);
        return valueCtx ? resolveValues(valueCtx, plan.attributes!, { allowRemove: true }) : [];
      },
    );
    const resolvedOf = new Map(targets.map((row, index) => [row.id, resolved[index]!]));

    const touched: TouchedVariant[] = [];
    for (const row of [...targets].sort((a, b) => a.id - b.id)) {
      try {
        const { valueChanges } = await writeVariantChange(
          { db, ...actor, batch: true },
          row,
          plan,
          {
            ...(valueCtx
              ? {
                  values: {
                    held: held.get(row.id) ?? new Map(),
                    resolved: resolvedOf.get(row.id)!,
                  },
                }
              : {}),
            // the pictures come after the row is written, before the line of the admin log
            ...(plan.images
              ? {
                  more: async (changes: AuditChange[]) => {
                    const pictures = imagesChangeOf(row, plan.images!);
                    if (!pictures) return;

                    await writeVariantImages(db, row.id, pictures.next);
                    changes.push({ field: 'images', old: pictures.old, new: pictures.next });
                  },
                }
              : {}),
          },
        );
        if (valueChanges.length) {
          touched.push({
            variantId: row.id,
            productId,
            categoryId: product.categoryId,
            ref: { variantId: row.id },
          });
        }
      } catch (err) {
        throw await refuseWrite(row.id, err);
      }
    }

    // the category's required characteristics are all there, and no variant repeats another
    await assertValuesAccepted(db, touched, { required: true });

    const after = await db.productVariant.findMany({
      where: { id: { in: [...found] } },
      select: variantRowSelect,
    });
    const afterById = new Map(after.map((row) => [row.id, row]));
    const context = await readVariantContext(db, after, 'admin', { full: true });

    return {
      variants: targets.map((row) => variantFullOf(afterById.get(row.id)!, context, 'admin')),
    };
  });
}

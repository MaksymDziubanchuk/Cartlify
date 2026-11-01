import { BadRequestError, NotFoundError } from '@utils/errors.js';

import {
  assertValuesAccepted,
  checkEveryVariant,
  checkVariantChange,
  codeWritesOf,
  imagesChangeOf,
  loadValueContext,
  lockProducts,
  mapProductPart,
  moveVariant,
  planVariantUpdate,
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
import {
  assertBatchCodesFree,
  lockGalleries,
  orderAfterMoves,
  readVariantOrders,
  refuseWrite,
  repeatedVariantIds,
  type Move,
} from './helpers/variantsBatch.helper.js';

import type { AuditChange } from '@db/adminAudit.helper.js';
import type {
  UpdateVariantsBatchDto,
  UpdateVariantsBatchResponseDto,
} from 'types/dto/variants.dto.js';

// PATCH /api/products/variants/batch: many variants, of any products, each with the fields of its
// own: any field of the change of one variant (the price with the word on the sale, the article
// number, the barcode, the weight and the sizes, the place, the pictures, the values of the
// characteristics). The change of each is the one of PATCH of one variant (the events are the ones of
// a request of many). All of them or none: the fields of every variant are checked first, then every
// variant as it is under the lock of its row (by id, so two such requests wait for each other);
// nothing is written while one is refused, and the refusal names every variant refused
// (VARIANTS_INVALID, details.variants) with its own error. A picture of an item is checked against
// the gallery of its own product (VARIANT_IMAGE_NOT_FOUND, the item is named).
//
// The codes are unique among the live variants of the catalog and checked on every write, so the
// request is checked as a whole: a code that a live variant holds now, a variant of the batch
// included, is taken (409 PRODUCT_SKU_TAKEN or VARIANT_BARCODE_TAKEN, details.variants names the
// items), and so is one that two items ask for; two variants cannot swap their codes in one request.
// A variant that is out of sale holds no code, the check comes when it is put back.
//
// The places move in the order of the items, after the other writes, the rows of the products
// locked first as PATCH of one variant locks its product; the line of the admin log has the place
// the variant ends at. The answer has the variants in the order of the items, each with its product
export async function updateVariantsBatch(
  dto: UpdateVariantsBatchDto,
): Promise<UpdateVariantsBatchResponseDto> {
  const { items } = dto;
  const actor = { actorId: dto.actorId, actorRole: dto.actorRole };

  const repeated = repeatedVariantIds(items.map((item) => item.variantId));
  if (repeated.length) throw new BadRequestError('VARIANTS_REPEATED', { variantIds: repeated });

  // the fields of every variant, every one checked
  const plans = await checkEveryVariant(
    items,
    (item) => item.variantId,
    (item) => planVariantUpdate(item),
  );

  return inVariantTx(
    actor,
    'VARIANTS_BATCH_UNEXPECTED',
    async (db) => {
      const ids = items.map((item) => item.variantId);

      // new values may make a variant repeat another of its product, and a move renumbers the others:
      // the requests that change the variants of a product wait for each other, the rows of the
      // products first (by id), then the rows of the variants
      const valuesAsked = plans.some((plan) => plan.attributes);
      const lockedFor = ids.filter(
        (_, index) => plans[index]!.attributes || plans[index]!.position !== undefined,
      );
      if (lockedFor.length) {
        const owners = await db.productVariant.findMany({
          where: { id: { in: lockedFor } },
          select: { productId: true },
        });
        await lockProducts(
          db,
          owners.map((row) => row.productId),
        );
      }
      await lockVariants(db, ids);

      const rows = await db.productVariant.findMany({
        where: { id: { in: ids } },
        select: variantRowSelect,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));

      const products = await db.product.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.productId))] } },
        select: productResponseSelect,
      });
      const productOf = new Map(products.map((product) => [product.id, product]));

      // the pictures of the items that change them are pictures of the gallery of their own product,
      // locked until the end (the rows of the pictures come after the rows of the variants)
      const asked = new Map<number, Set<number>>();
      for (const [index, item] of items.entries()) {
        const row = byId.get(item.variantId);
        const images = plans[index]!.images;
        if (!row || !images?.length || !imagesChangeOf(row, images)) continue;

        const ofProduct = asked.get(row.productId) ?? new Set<number>();
        for (const image of images) ofProduct.add(image.key);
        asked.set(row.productId, ofProduct);
      }
      const inGallery = await lockGalleries(db, asked);

      // the places the moves leave, the moves taken one after the other in the order of the items
      const moves: Move[] = items.flatMap((item, index) => {
        const row = byId.get(item.variantId);
        const position = plans[index]!.position;

        return row && position !== undefined
          ? [{ productId: row.productId, variantId: row.id, position }]
          : [];
      });
      const movedOrders = orderAfterMoves(
        await readVariantOrders(db, [...new Set(moves.map((move) => move.productId))]),
        moves,
      );
      const endPlaceOf = (row: { id: number; productId: number }): number | undefined => {
        const at = movedOrders.get(row.productId)?.indexOf(row.id) ?? -1;
        return at < 0 ? undefined : at + 1;
      };

      // the values of the characteristics, each against the directory (read and kept as it is until
      // the end)
      const valueCtx = valuesAsked
        ? await loadValueContext(
            db,
            plans.flatMap((plan) => plan.attributes ?? []),
          )
        : undefined;
      const held = valuesAsked ? await readHeldValues(db, ids) : new Map();

      // every variant as it is: a variant that is not there, one the change does not fit, a picture
      // that is not in the gallery of its product
      const befores = await checkEveryVariant(
        items,
        (item) => item.variantId,
        (item, index) => {
          const row = byId.get(item.variantId);
          if (!row) throw new NotFoundError('VARIANT_NOT_FOUND');

          const plan = plans[index]!;
          checkVariantChange(row, productOf.get(row.productId)!, plan);

          if (plan.images?.length && imagesChangeOf(row, plan.images)) {
            const found = inGallery.get(row.productId);
            const missing = plan.images.map((image) => image.key).filter((id) => !found?.has(id));
            if (missing.length)
              throw new BadRequestError('VARIANT_IMAGE_NOT_FOUND', { imageIds: missing });
          }

          return {
            row,
            resolved:
              valueCtx && plan.attributes
                ? resolveValues(valueCtx, plan.attributes, { allowRemove: true })
                : undefined,
          };
        },
      );

      // the codes the items change are free, the items taken as a whole
      await assertBatchCodesFree(
        db,
        befores.flatMap(({ row }, index) => {
          if (row.deletedAt) return [];

          const codes = codeWritesOf(row, plans[index]!);
          return codes.sku || codes.barcode
            ? [{ variantId: row.id, sku: codes.sku, barcode: codes.barcode }]
            : [];
        }),
      );

      // the writes go by id, the order the rows were locked in
      const order = [...items.keys()].sort((a, b) => items[a]!.variantId - items[b]!.variantId);
      const touched: TouchedVariant[] = [];
      for (const index of order) {
        const { row, resolved } = befores[index]!;
        const plan = plans[index]!;
        const codes = codeWritesOf(row, plan);
        const endPlace = plan.position !== undefined ? endPlaceOf(row) : undefined;

        try {
          const { valueChanges } = await writeVariantChange(
            { db, ...actor, batch: true },
            row,
            plan,
            {
              data: codes.data,
              changes: codes.changes,
              ...(resolved ? { values: { held: held.get(row.id) ?? new Map(), resolved } } : {}),
              // the place and the pictures come after the row is written, before the line of the
              // admin log (the place itself is moved after all of the writes)
              more: async (changes: AuditChange[]) => {
                if (endPlace !== undefined && endPlace !== row.position) {
                  changes.push({ field: 'position', old: row.position, new: endPlace });
                }

                const pictures = plan.images && imagesChangeOf(row, plan.images);
                if (pictures) {
                  await writeVariantImages(db, row.id, pictures.next);
                  changes.push({ field: 'images', old: pictures.old, new: pictures.next });
                }
              },
            },
          );
          if (valueChanges.length) {
            touched.push({
              variantId: row.id,
              productId: row.productId,
              categoryId: productOf.get(row.productId)!.categoryId,
              ref: { variantId: row.id },
            });
          }
        } catch (err) {
          throw await refuseWrite(items[index]!.variantId, err);
        }
      }

      // the places, one move after the other in the order of the items
      for (const move of moves) {
        await moveVariant(db, move.productId, move.variantId, move.position);
      }

      // the category's required characteristics are all there, and no variant repeats another
      await assertValuesAccepted(db, touched, { required: true });

      const after = await db.productVariant.findMany({
        where: { id: { in: ids } },
        select: variantRowSelect,
      });
      const afterById = new Map(after.map((row) => [row.id, row]));
      const context = await readVariantContext(db, after, 'admin', { full: true });

      return {
        items: items.map((item) => {
          const row = afterById.get(item.variantId)!;
          const product = productOf.get(row.productId)!;

          return {
            product: mapProductPart(product, 'admin'),
            variant: variantFullOf(row, context, 'admin'),
          };
        }),
      };
    },
    { timeout: 30_000 },
  );
}

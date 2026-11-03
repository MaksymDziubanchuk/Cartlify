import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { BadRequestError, InternalError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { normalizeWarnings } from '@helpers/party.js';
import { parseWithdrawalRule } from '@helpers/withdrawal.js';

import {
  assertCategoryExists,
  assertCodesFree,
  assertValuesAccepted,
  discardMovedImages,
  imagesTxTimeout,
  knownVariantDbError,
  loadValueContext,
  logVariant,
  moveStagedImages,
  newVariantChanges,
  normalizeCreateProductInput,
  parseVariantsText,
  planNewVariants,
  readAdminCard,
  repeatedCodes,
  resolveNewVariants,
  stageProductImages,
  writeValues,
  type TouchedVariant,
} from './helpers/index.js';

import { partyConflictOf } from '@routes/api/parties/services/helpers/parties.helper.js';
import {
  assertDocumentsExist,
  readDocumentIds,
  replaceProductDocuments,
} from './helpers/productDocuments.helper.js';
import {
  newPartyValuesOf,
  planCreateParties,
  resolveCreateParties,
} from './helpers/productParties.helper.js';

import type { CreateProductDto, CreateProductResponseDto } from 'types/dto/products.dto.js';
import type { AuditChange } from '@db/adminAudit.helper.js';
import type { UploadImageResult } from '@utils/cloudinary.util.js';

// POST /api/products: a product with its variants and its gallery from one form. The files are the
// gallery of the product (the place of a file is its number in the form); every variant shows some
// of them, with a place of its own for each (`variants`, a JSON list; a picture is named by the
// number of its file). A variant without a picture is VARIANT_IMAGE_REQUIRED, a file that no
// variant shows is GALLERY_IMAGE_UNUSED; a variant that is wrong is named with its error among the
// others (VARIANTS_INVALID). The product, its variants, its pictures and its lines of the admin log
// are written together, or not at all
export async function createProduct({
  actorId,
  actorRole,
  productId,
  name,
  description,
  manufacturerId,
  manufacturer,
  euResponsibleId,
  euResponsible,
  warnings,
  withdrawal,
  documentIds,
  categoryId,
  variants,
  images,
  stock,
  log,
}: CreateProductDto): Promise<CreateProductResponseDto> {
  // validate actor context for rls and admin-only create
  assertAdminActor(actorId, actorRole);

  // normalize and validate required scalar fields
  // a stock sent is refused: a new product has none, it comes with a delivery
  const { nameNorm, descriptionNorm, categoryIdRaw } = normalizeCreateProductInput({
    name,
    description,
    categoryId,
    stock,
  });
  // a new product names its manufacturer and who answers for it in the EU (GPSR): parties of the
  // directory by their ids, or new ones by their values
  const partiesPlan = planCreateParties({
    manufacturerId,
    manufacturer,
    euResponsibleId,
    euResponsible,
  });
  const warningsNorm = normalizeWarnings(warnings);
  // the rule of withdrawal of its own, none when the field is empty or not sent
  const withdrawalNorm = parseWithdrawalRule(withdrawal) ?? null;
  // the documents of the directory the product names, in their order
  const documentIdsNorm = readDocumentIds(documentIds) ?? [];

  // reject invalid payload when controller sent no uploads
  if (!Array.isArray(images) || images.length === 0) {
    throw new BadRequestError('PRODUCT_IMAGES_REQUIRED');
  }

  // the variants: their fields, their pictures by the number of the file
  const plans = planNewVariants(parseVariantsText(variants), {
    kind: 'files',
    count: images.length,
  });

  // a file that no variant shows is a picture of the gallery nobody can see
  const shown = new Set(plans.flatMap((plan) => plan.images.map((image) => image.key)));
  const unused = images.map((_, index) => index).filter((index) => !shown.has(index));
  if (unused.length) throw new BadRequestError('GALLERY_IMAGE_UNUSED', { files: unused });

  // prepare audit changes list for create
  const auditChanges: AuditChange[] = [
    { field: 'name', old: null, new: nameNorm },
    { field: 'description', old: null, new: descriptionNorm ?? null },
    { field: 'categoryId', old: null, new: categoryIdRaw },
  ];

  // the uploads that moved to the paths of the product, for a failure after some of them
  const moved = new Map<string, UploadImageResult>();

  try {
    // create product row, its gallery, its variants, log admin actions and place the images in
    // one tx
    await prisma.$transaction(
      async (tx) => {
        // set db session context for rls policies
        await setUserContext(tx, { userId: actorId, role: actorRole });

        await assertCategoryExists(tx, categoryIdRaw);

        // the parties of the directory, a new one added to it here (with a line of its own in the
        // admin log); the rule of the EU is checked on them
        const parties = await resolveCreateParties(tx, partiesPlan, { actorId, actorRole });

        // the codes of the variants are free, before anything is written
        await assertCodesFree(tx, plans, { repeated: repeatedCodes(plans) });

        // the values of the characteristics of the variants, each against the directory (read and
        // kept as it is until the end), before anything is written
        const valueCtx = await loadValueContext(
          tx,
          plans.flatMap((plan) => plan.attributes),
        );
        const resolved = resolveNewVariants(valueCtx, plans);

        // create product row with reserved id from controller flow
        const product = await tx.product.create({
          data: {
            id: productId,
            name: nameNorm,
            description: descriptionNorm ?? null,
            manufacturerId: parties.manufacturer.id,
            euResponsibleId: parties.euResponsible?.id ?? null,
            warnings: warningsNorm,
            withdrawal: withdrawalNorm,
            categoryId: categoryIdRaw,
          },
          select: { id: true },
        });

        // the documents named, which must be in the directory of documents
        await assertDocumentsExist(tx, documentIdsNorm);
        await replaceProductDocuments(tx, product.id, documentIdsNorm);

        // the gallery: a row for each file, in the order of the form; the files move last
        const staged = await stageProductImages({ tx, productId: product.id, uploads: images });

        // write admin audit log for product create
        await writeAdminAuditLog(tx, {
          actorId,
          actorRole,
          entityType: 'product',
          entityId: product.id,
          action: 'PRODUCT_CREATE',
          event: 'product.create',
          changes: [
            ...auditChanges,
            { field: 'manufacturerId', old: null, new: parties.manufacturer.id },
            ...(parties.euResponsible
              ? [{ field: 'euResponsibleId', old: null, new: parties.euResponsible.id }]
              : []),
            ...(warningsNorm ? [{ field: 'warnings', old: null, new: warningsNorm }] : []),
            ...(withdrawalNorm ? [{ field: 'withdrawal', old: null, new: withdrawalNorm }] : []),
            ...(documentIdsNorm.length
              ? [{ field: 'documentIds', old: null, new: documentIdsNorm }]
              : []),
          ],
        });

        // the variants take the places 1, 2, ... in the order of the list
        const touched: TouchedVariant[] = [];
        for (const [index, plan] of plans.entries()) {
          const position = index + 1;
          const refs = plan.images.map((image) => ({
            imageId: staged[image.key]!.id,
            position: image.position,
          }));

          const variant = await tx.productVariant.create({
            data: {
              productId: product.id,
              position,
              price: plan.price,
              sku: plan.sku,
              barcode: plan.barcode,
              ...plan.shipping,
              images: { create: refs },
            },
            select: { id: true },
          });

          const valueChanges = await writeValues(tx, variant.id, new Map(), resolved[index]!);
          touched.push({
            variantId: variant.id,
            productId: product.id,
            categoryId: categoryIdRaw,
            ref: { index },
          });

          await logVariant(
            tx,
            { actorId, actorRole },
            {
              event: 'variant.create',
              variantId: variant.id,
              changes: [...newVariantChanges(product.id, position, plan, refs), ...valueChanges],
            },
          );
        }

        // the category asks for its required characteristics, and no variant repeats another
        await assertValuesAccepted(tx, touched, { required: true });

        // the uploads move to the paths of the product last, once every row is written
        await moveStagedImages({ tx, staged, moved });

        return product;
        // the moves at cloudinary run inside the transaction: it is given time for each file
      },
      { timeout: imagesTxTimeout(images.length) },
    );
  } catch (err) {
    // the uploads that moved before the failure have no row, they go
    await discardMovedImages(moved, log);

    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    // a code that another live variant took meanwhile
    const known = await knownVariantDbError(err);
    if (known) throw known;

    // a new party the directory already holds: 409 names it, the request comes again with its id
    for (const values of newPartyValuesOf(partiesPlan)) {
      const conflict = await partyConflictOf(err, values);
      if (isAppError(conflict)) throw conflict;
    }

    throw new InternalError({ reason: 'PRODUCTS_CREATE_UNEXPECTED' }, err);
  }

  // the card of an admin: the main variant, the others to switch to, the gallery. The product is
  // written, a failure to read it back leaves its files where they are
  return readAdminCard({ actorId, actorRole }, productId);
}

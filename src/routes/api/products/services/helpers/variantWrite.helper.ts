import type { Prisma } from '@prisma/client';

import { writeAdminAuditLog, type AuditChange } from '@db/adminAudit.helper.js';
import { getPgMessage } from '@db/client.js';
import {
  isForeignKeyViolationOn,
  isUniqueViolationOn,
} from '@routes/api/attributes/services/helpers/directory.helper.js';
import { BadRequestError, ConflictError, NotFoundError, type AppError } from '@utils/errors.js';

import type { AuditEvent, WrittenEvent } from '@config/journalEvents.js';
import type { VariantActorDto } from 'types/dto/variants.dto.js';

import type { VariantRow } from './variant.helper.js';
import type { NewVariantPlan, VariantImageSpec } from './variantInput.helper.js';

type Tx = Prisma.TransactionClient;

// the writes of the variants of a product that its routes share (create, change, delete, restore):
// the checks that need the database, the pictures, the codes, the place, the line of the admin log

// Locks the pictures of the gallery of a product that are among the ids given, until the end of the
// transaction, and gives the ids that were there. A variant is bound to a picture only while the
// picture is in the gallery: the lock keeps a delete of the picture (DELETE .../images/:imageId)
// waiting until the variant has its binding, and a picture deleted before the lock is not among the
// rows (a row deleted by a request that committed is skipped, the way a row of another product is).
// The lock is a key share, the one the foreign key of variant_images takes; it comes in the order
// of the ids, after the rows of the product and of the variants
export async function lockGalleryImages(
  tx: Tx,
  productId: number,
  ids: readonly number[],
): Promise<Set<number>> {
  if (!ids.length) return new Set();

  const rows = await tx.$queryRaw<{ id: number }[]>`
    select id from cartlify.product_images
    where "productId" = ${productId}::int and id = any(${[...ids]}::int[])
    order by id
    for key share
  `;

  return new Set(rows.map((row) => row.id));
}

// the pictures named are pictures of the gallery of the product, else 400 VARIANT_IMAGE_NOT_FOUND;
// they stay in the gallery until the end of the transaction (lockGalleryImages)
export async function assertGalleryImages(
  tx: Tx,
  productId: number,
  imageIds: readonly number[],
): Promise<void> {
  const ids = [...new Set(imageIds)];
  const found = await lockGalleryImages(tx, productId, ids);
  const missing = ids.filter((id) => !found.has(id));

  if (missing.length) throw new BadRequestError('VARIANT_IMAGE_NOT_FOUND', { imageIds: missing });
}

// the pictures of the variants of a request are pictures of the gallery of the product: a variant
// whose picture is not there is named with VARIANT_IMAGE_NOT_FOUND (400 VARIANTS_INVALID, the way
// the other wrong variants of a request are), with the ids that are missing. The pictures stay in
// the gallery until the end of the transaction (lockGalleryImages)
export async function assertGalleryImagesOfVariants(
  tx: Tx,
  productId: number,
  plans: ReadonlyArray<{ images: ReadonlyArray<{ key: number }> }>,
): Promise<void> {
  const ids = [...new Set(plans.flatMap((plan) => plan.images.map((image) => image.key)))];
  const found = await lockGalleryImages(tx, productId, ids);

  const problems = plans.flatMap((plan, index) => {
    const missing = plan.images.map((image) => image.key).filter((id) => !found.has(id));

    return missing.length
      ? [{ index, errorCode: 'VARIANT_IMAGE_NOT_FOUND', details: { imageIds: missing } }]
      : [];
  });

  if (problems.length) throw new BadRequestError('VARIANTS_INVALID', { variants: problems });
}

// the product exists (a product that is not there is 404); the row is read as it is, not locked
// (lockProduct, lockProductThere)
export async function assertProductThere(
  tx: Tx,
  productId: number,
): Promise<{ id: number; name: string; deletedAt: Date | null; categoryId: number }> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, deletedAt: true, categoryId: true },
  });
  if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');

  return product;
}

// Locks the row of the product until the end of the transaction. The variants of a product take
// places among each other (a new one the next free place, a moved one renumbers the others), so the
// requests that do it wait for each other here and meet no clash of the places. The key of the
// places is checked at the end of the transaction all the same (inAdminTx runs a request that
// lost it again), for a write that does not wait here.
//
// The order of the locks of a request is the same everywhere: the row of the product first, then
// the rows of its variants (by id), then the rows of the pictures of its gallery (by id). Two
// requests that take them in that order wait for each other and meet no deadlock
export async function lockProduct(tx: Tx, productId: number): Promise<void> {
  await tx.$queryRaw`select id from cartlify.products where id = ${productId}::int for update`;
}

// the product, read after its row is locked: what a request goes on from (deletedAt above all) is
// what the request that held the lock left, not what it was before the wait. A product that is not
// there is 404
export async function lockProductThere(
  tx: Tx,
  productId: number,
): Promise<{ id: number; name: string; deletedAt: Date | null; categoryId: number }> {
  await lockProduct(tx, productId);

  return assertProductThere(tx, productId);
}

// Locks the rows of products until the end of the transaction, by id: a request over variants of
// several products takes them in one order and meets no deadlock with another such request. The
// rows of the variants come after them
export async function lockProducts(tx: Tx, productIds: readonly number[]): Promise<void> {
  const ids = [...new Set(productIds)].sort((a, b) => a - b);
  if (!ids.length) return;

  await tx.$queryRaw`
    select id from cartlify.products where id = any(${ids}::int[]) order by id for update
  `;
}

// Locks the row of a variant of the product until the end of the transaction; false when the
// product has no such variant. A request that reads the variant after the lock sees what the
// request that held it left (two deletes, or two restores, of one variant act once)
export async function lockVariantOfProduct(
  tx: Tx,
  productId: number,
  variantId: number,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    select id from cartlify.product_variants
    where id = ${variantId}::int and "productId" = ${productId}::int
    for update
  `;

  return rows.length > 0;
}

// The article numbers and the barcodes that a live variant of the catalog has already, among the
// ones given. A code is taken by a live variant only (a variant taken out of sale lets it go,
// db/06); ignoreVariantId leaves the variant that is changed out. The article number counts
// whatever the case of its letters. Gives the indexes of the items whose code is taken
export async function takenCodes(
  tx: Tx,
  items: ReadonlyArray<{ sku: string | null; barcode: string | null }>,
  opts: { ignoreVariantId?: number } = {},
): Promise<{ skus: number[]; barcodes: number[] }> {
  const skus = [...new Set(items.flatMap((item) => (item.sku ? [item.sku.toLowerCase()] : [])))];
  const barcodes = [...new Set(items.flatMap((item) => (item.barcode ? [item.barcode] : [])))];
  const ignore = opts.ignoreVariantId ?? 0;

  const skuRows = skus.length
    ? await tx.$queryRaw<{ sku: string }[]>`
        select lower(sku) as sku from cartlify.product_variants
        where "deletedAt" is null and lower(sku) = any(${skus}::text[]) and id <> ${ignore}::int
      `
    : [];
  const barcodeRows = barcodes.length
    ? await tx.$queryRaw<{ barcode: string }[]>`
        select barcode from cartlify.product_variants
        where "deletedAt" is null and barcode = any(${barcodes}::text[]) and id <> ${ignore}::int
      `
    : [];

  const takenSkus = new Set(skuRows.map((row) => row.sku));
  const takenBarcodes = new Set(barcodeRows.map((row) => row.barcode));

  const indexes = (taken: Set<string>, codeOf: (item: (typeof items)[number]) => string | null) =>
    items.flatMap((item, index) => {
      const code = codeOf(item);
      return code !== null && taken.has(code) ? [index] : [];
    });

  return {
    skus: indexes(takenSkus, (item) => item.sku?.toLowerCase() ?? null),
    barcodes: indexes(takenBarcodes, (item) => item.barcode),
  };
}

// The codes of the variants about to be written are free: no live variant of the catalog has them
// (takenCodes), and the variants of the request do not share them (repeated: the indexes of the
// later variants that repeat an earlier one). 409 PRODUCT_SKU_TAKEN or VARIANT_BARCODE_TAKEN names
// the variants of the request whose code is the trouble, by their index (details.variants), or the
// code itself for a single variant
export async function assertCodesFree(
  tx: Tx,
  items: ReadonlyArray<{ sku: string | null; barcode: string | null }>,
  opts: {
    ignoreVariantId?: number;
    repeated?: { skus: number[]; barcodes: number[] };
    single?: boolean;
  } = {},
): Promise<void> {
  const taken = await takenCodes(
    tx,
    items,
    opts.ignoreVariantId ? { ignoreVariantId: opts.ignoreVariantId } : {},
  );

  const named = (indexes: number[], field: 'sku' | 'barcode') => {
    const sorted = [...new Set(indexes)].sort((a, b) => a - b);

    return opts.single
      ? { [field]: items[sorted[0]!]![field] }
      : { variants: sorted.map((index) => ({ index, [field]: items[index]![field] })) };
  };

  const skus = [...taken.skus, ...(opts.repeated?.skus ?? [])];
  if (skus.length) throw new ConflictError('PRODUCT_SKU_TAKEN', named(skus, 'sku'));

  const barcodes = [...taken.barcodes, ...(opts.repeated?.barcodes ?? [])];
  if (barcodes.length) throw new ConflictError('VARIANT_BARCODE_TAKEN', named(barcodes, 'barcode'));
}

// the pictures a variant shows, written whole: the old ones go, the new ones come. The places of a
// variant are a key checked at the end of the transaction (variant_images_position_key)
export async function writeVariantImages(
  tx: Tx,
  variantId: number,
  images: ReadonlyArray<{ imageId: number; position: number }>,
): Promise<void> {
  await tx.variantImage.deleteMany({ where: { variantId } });
  if (!images.length) return;

  await tx.variantImage.createMany({
    data: images.map((image) => ({ variantId, imageId: image.imageId, position: image.position })),
  });
}

// the pictures of a variant as specs of the gallery
export const imageRefsOf = (specs: readonly VariantImageSpec[]) =>
  specs.map((spec) => ({ imageId: spec.key, position: spec.position }));

export type ImageRef = { imageId: number; position: number };

// the pictures a variant shows now, by their places
export const imagesOf = (row: Pick<VariantRow, 'images'>): ImageRef[] =>
  row.images.map((shown) => ({ imageId: shown.image.id, position: shown.position }));

// The pictures a change writes whole, against what the variant shows now: null when they are the
// same pictures at the same places (nothing is written, no line is made), else what is shown now and
// what will be shown, as the line of the admin log has them
export function imagesChangeOf(
  row: Pick<VariantRow, 'images'>,
  specs: readonly VariantImageSpec[],
): { old: ImageRef[]; next: ImageRef[] } | null {
  const old = imagesOf(row);
  const next = imageRefsOf(specs);
  const same =
    old.length === next.length &&
    old.every(
      (shown, at) => shown.imageId === next[at]!.imageId && shown.position === next[at]!.position,
    );

  return same ? null : { old, next };
}

// the article number and the barcode a change really changes, with the fields to write and the
// lines of the admin log. The code of the variant in another case of letters is a change; what the
// variant has already is none. undefined: not changed (null is a code taken away)
export function codeWritesOf(
  before: Pick<VariantRow, 'sku' | 'barcode'>,
  plan: { sku?: string | null | undefined; barcode?: string | null | undefined },
): {
  sku: string | null | undefined;
  barcode: string | null | undefined;
  data: Prisma.ProductVariantUpdateInput;
  changes: AuditChange[];
} {
  const sku = plan.sku !== undefined && plan.sku !== before.sku ? plan.sku : undefined;
  const barcode =
    plan.barcode !== undefined && plan.barcode !== before.barcode ? plan.barcode : undefined;

  const data: Prisma.ProductVariantUpdateInput = {};
  const changes: AuditChange[] = [];
  if (sku !== undefined) {
    data.sku = sku;
    changes.push({ field: 'sku', old: before.sku, new: sku });
  }
  if (barcode !== undefined) {
    data.barcode = barcode;
    changes.push({ field: 'barcode', old: before.barcode, new: barcode });
  }

  return { sku, barcode, data, changes };
}

// The ids of the variants of a product in their order after one is put at a place: the order
// without it, the variant put in at the place. A place past the last one is the last
export function movedOrder(
  order: readonly number[],
  variantId: number,
  position: number,
): number[] {
  const moved = order.filter((id) => id !== variantId);
  moved.splice(Math.min(position, order.length) - 1, 0, variantId);

  return moved;
}

// puts the variant at the place asked and the others around it: the order of the variants of the
// product (the ones taken out of sale too) without it, the variant put in at the place, everybody
// renumbered from 1. The places are a key checked at the end of the transaction
// (product_variants_position_key), so the updates go in any order; a request that took the same
// places meanwhile makes the commit fail and the transaction runs again. The caller holds the row
// of the product (lockProduct)
export async function moveVariant(
  tx: Tx,
  productId: number,
  variantId: number,
  position: number,
): Promise<void> {
  const rows = await tx.productVariant.findMany({
    where: { productId },
    select: { id: true, position: true },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });

  const order = movedOrder(
    rows.map((row) => row.id),
    variantId,
    position,
  );

  const placeOf = new Map(rows.map((row) => [row.id, row.position]));
  for (const [index, id] of order.entries()) {
    if (placeOf.get(id) === index + 1) continue;

    await tx.productVariant.update({ where: { id }, data: { position: index + 1 } });
  }
}

// a line of the admin log of a variant: its entity is the variant, the action OTHER, the event
// says what happened
export function logVariant(
  tx: Tx,
  actor: VariantActorDto,
  line: { event: WrittenEvent<AuditEvent>; variantId: number; changes: AuditChange[] },
): Promise<void> {
  return writeAdminAuditLog(tx, {
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    entityType: 'variant',
    entityId: line.variantId,
    action: 'OTHER',
    event: line.event,
    changes: line.changes,
  });
}

// the codes the trigger of the values of characteristics raises (db/05)
const VALUE_DB_ERRORS = [
  'ATTRIBUTE_VALUE_INVALID',
  'ATTRIBUTE_VALUE_TOO_PRECISE',
  'ATTRIBUTE_VALUE_TOO_SMALL',
  'ATTRIBUTE_VALUE_TOO_LARGE',
  'ATTRIBUTE_OPTION_NOT_FOUND',
] as const;

// a failure of the database the routes of the variants know: the article number or the barcode that
// another live variant took meanwhile (the unique indexes of db/06), a picture that is not in the
// gallery of the product (the guard of db/05) or that went from it between the check and the write
// (the foreign key of variant_images; the routes lock the pictures they check, so this is the net
// under the lock), the end of a sale that went by between the check and the write, by the clock of
// the database (db/05)
export async function knownVariantDbError(err: unknown): Promise<AppError | null> {
  if (isUniqueViolationOn(err, 'product_variants_sku_catalog_uidx')) {
    return new ConflictError('PRODUCT_SKU_TAKEN');
  }
  if (isUniqueViolationOn(err, 'product_variants_barcode_catalog_uidx')) {
    return new ConflictError('VARIANT_BARCODE_TAKEN');
  }
  if (isForeignKeyViolationOn(err, 'variant_images_imageId_fkey')) {
    return new BadRequestError('VARIANT_IMAGE_NOT_FOUND');
  }
  const message = String(getPgMessage(err) ?? '');
  if (message.includes('VARIANT_IMAGE_NOT_FOUND')) {
    return new BadRequestError('VARIANT_IMAGE_NOT_FOUND');
  }
  if (message.includes('VARIANT_SALE_ENDS_AT_INVALID')) {
    return new BadRequestError('PRODUCT_SALE_ENDS_AT_INVALID');
  }

  // a value of a characteristic the directory changed between the check and the write (db/05 keeps
  // the value within the type, the bounds and the values of its characteristic); the check of the
  // service names the characteristic, this is the net under it
  for (const code of VALUE_DB_ERRORS) {
    if (message.includes(code)) return new BadRequestError(code);
  }

  return null;
}

// what a new variant puts in the line of the admin log: the fields it was made with
export function newVariantChanges(
  productId: number,
  position: number,
  plan: NewVariantPlan,
  images: ReadonlyArray<{ imageId: number; position: number }>,
): AuditChange[] {
  return [
    { field: 'productId', old: null, new: productId },
    { field: 'position', old: null, new: position },
    { field: 'price', old: null, new: plan.price },
    ...(plan.sku ? [{ field: 'sku', old: null, new: plan.sku }] : []),
    ...(plan.barcode ? [{ field: 'barcode', old: null, new: plan.barcode }] : []),
    ...Object.entries(plan.shipping)
      .filter(([, value]) => value !== null)
      .map(([field, value]) => ({ field, old: null, new: value })),
    { field: 'images', old: null, new: images },
  ];
}

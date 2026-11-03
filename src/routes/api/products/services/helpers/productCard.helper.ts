import type { Prisma } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { readProductWithdrawals } from '@db/productWithdrawal.helper.js';
import { InternalError, NotFoundError } from '@utils/errors.js';

import { readCategoryPath } from './productCategory.helper.js';
import { readProductExtras } from './productExtras.helper.js';
import {
  mapGallery,
  mapProductCard,
  productResponseSelect,
  type ProductView,
} from './productMapper.helper.js';
import {
  mainVariantOf,
  readVariantContext,
  variantFullOf,
  variantRowSelect,
  variantShortOf,
  visibleVariantWhere,
  type VariantRow,
} from './variant.helper.js';
import { readCardAttributes } from './variantCardAttributes.helper.js';

import type { FullProductResponseDto } from 'types/dto/products.dto.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

type Db = Prisma.TransactionClient;

// The card of a product page, built in the transaction of the caller (its context is set): the
// product, the variant it opens and the short form of the variants to switch between.
// - A buyer sees a product that is there, and its variants that are for sale and show a picture
//   (isVariantVisible); a product with none, or a removed one, is PRODUCT_NOT_FOUND; a variant that
//   is not among them is VARIANT_NOT_FOUND. His visit is a view of the product.
// - An admin sees every product and every variant of it, removed ones and ones without a picture
//   too; the visit is no view.
// - The variant opened is the one asked for. Without one the main variant: the first by its place
//   with free units, the first of all when none has; an admin gets the one a buyer would get (the
//   variants for sale that show a picture first, the ones for sale after, the rest last)
export async function buildProductCard(
  db: Db,
  args: { productId: number; view: ProductView; variantId?: number; countView?: boolean },
): Promise<FullProductResponseDto> {
  const { productId, view } = args;

  const product = await db.product.findUnique({
    where: { id: productId },
    select: productResponseSelect,
  });
  if (!product || (product.deletedAt && view !== 'admin')) {
    throw new NotFoundError('PRODUCT_NOT_FOUND');
  }

  const rows = await db.productVariant.findMany({
    where: { productId, ...(view === 'buyer' ? visibleVariantWhere : {}) },
    select: variantRowSelect,
    orderBy: { position: 'asc' },
  });

  if (!rows.length) {
    // a product a buyer finds no variant of is not in the catalog for him; a product of the shop
    // always has a variant
    if (view === 'buyer') throw new NotFoundError('PRODUCT_NOT_FOUND');
    throw new InternalError({ reason: 'PRODUCT_WITHOUT_VARIANTS', productId });
  }

  const context = await readVariantContext(db, rows, view);

  let opened: VariantRow | undefined;
  if (args.variantId !== undefined) {
    opened = rows.find((row) => row.id === args.variantId);
    if (!opened) throw new NotFoundError('VARIANT_NOT_FOUND');
  } else {
    const candidates = [
      rows.filter((row) => row.deletedAt === null && row.images.length > 0),
      rows.filter((row) => row.deletedAt === null),
      rows,
    ].find((list) => list.length > 0)!;
    opened = mainVariantOf(candidates, context)!;
  }

  // the gallery with the variants that show each picture, for an admin
  let gallery;
  if (view === 'admin') {
    const images = await db.productImage.findMany({
      where: { productId },
      select: { id: true, url: true, position: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    const variantIdsOf = new Map<number, number[]>();
    for (const row of rows) {
      for (const shown of row.images) {
        const ids = variantIdsOf.get(shown.image.id) ?? [];
        ids.push(row.id);
        variantIdsOf.set(shown.image.id, ids);
      }
    }
    gallery = mapGallery(images, variantIdsOf);
  }

  // a visit of a buyer is a view of the product, the one of an admin is not. A plain update of
  // the counter: prisma would set updatedAt too, and the last change of a product is a change an
  // admin made
  if (args.countView && view === 'buyer') {
    await db.$executeRaw`
      update cartlify.products set views = views + 1 where id = ${productId}::int
    `;
  }

  const extras = (await readProductExtras([product]))(product);
  const withdrawal = (await readProductWithdrawals(db, [productId])).get(productId);
  if (!withdrawal) throw new NotFoundError('PRODUCT_NOT_FOUND');

  return {
    product: mapProductCard({
      product,
      categoryPath: await readCategoryPath(product.category.id, db),
      extras,
      withdrawal,
      ...(gallery ? { gallery } : {}),
      view,
    }),
    // the characteristics are read for the variant that is opened only
    variant: variantFullOf(
      opened,
      { ...context, attributes: await readCardAttributes(db, [opened.id]) },
      view,
    ),
    variants: rows.map((row) => variantShortOf(row, context, view)),
  };
}

// the gallery of a product as an admin sees it: every picture with the variants that show it, the
// ones taken out of sale too
export async function readGallery(db: Db, productId: number) {
  const images = await db.productImage.findMany({
    where: { productId },
    select: { id: true, url: true, position: true },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  const bound = await db.variantImage.findMany({
    where: { image: { productId } },
    select: { imageId: true, variantId: true },
    orderBy: { variantId: 'asc' },
  });

  const variantIdsOf = new Map<number, number[]>();
  for (const { imageId, variantId } of bound) {
    variantIdsOf.set(imageId, [...(variantIdsOf.get(imageId) ?? []), variantId]);
  }

  return mapGallery(images, variantIdsOf);
}

// the card of an admin in a transaction of its own, for an answer read after the transaction that
// changed the product is over
export async function readAdminCard(
  actor: { actorId: UserId; actorRole: Role },
  productId: number,
  variantId?: number,
): Promise<FullProductResponseDto> {
  return prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: actor.actorId, role: actor.actorRole });

    return buildProductCard(tx, {
      productId,
      view: 'admin',
      ...(variantId !== undefined ? { variantId } : {}),
    });
  });
}

// the cards of an admin of several products, in the order given, read in one transaction after the
// one that changed them is over
export async function readAdminCards(
  actor: { actorId: UserId; actorRole: Role },
  productIds: readonly number[],
): Promise<FullProductResponseDto[]> {
  return prisma.$transaction(
    async (tx) => {
      await setUserContext(tx, { userId: actor.actorId, role: actor.actorRole });

      const cards: FullProductResponseDto[] = [];
      for (const productId of productIds) {
        cards.push(await buildProductCard(tx, { productId, view: 'admin' }));
      }
      return cards;
    },
    { timeout: 30_000 },
  );
}

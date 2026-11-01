import { getPgMessage, prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import { Prisma } from '@prisma/client';
import { assertLimit } from '@helpers/assertLimit.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import {
  mapProductListPart,
  productResponseSelect,
} from '../products/services/helpers/productMapper.helper.js';
import {
  readVariantContext,
  variantRowSelect,
  variantShortOf,
  visibleVariantWhere,
} from '../products/services/helpers/variant.helper.js';

import { BadRequestError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';
import type {
  FindFavoritesDto,
  GetFavoritesResponseDto,
  AddFavoriteDto,
  AddFavoriteResponseDto,
  DeleteFavoriteDto,
  DeleteFavoriteResponseDto,
} from 'types/dto/favorites.dto.js';

// the variants a buyer sees: alive, with a picture, of a product that is in the catalog
const BUYER_VARIANT = { ...visibleVariantWhere, product: { deletedAt: null } };

async function findFavorites(dto: FindFavoritesDto): Promise<GetFavoritesResponseDto> {
  // normalize keyset pagination input
  const limit = assertLimit(dto.limit ?? 20);

  const cursor =
    typeof dto.cursor === 'string' && dto.cursor.trim() ? dto.cursor.trim() : undefined;

  // decode and validate keyset cursor payload
  const cRaw = cursor ? decodeCursor(cursor) : undefined;

  const c =
    cRaw && typeof cRaw.v === 'string' && cRaw.v.length
      ? (() => {
          const d = new Date(cRaw.v);
          if (Number.isNaN(d.getTime())) throw new BadRequestError('CURSOR_INVALID');
          return { id: cRaw.id, createdAt: d };
        })()
      : cRaw
        ? (() => {
            throw new BadRequestError('CURSOR_INVALID');
          })()
        : undefined;

  // build keyset window for createdAt desc + id desc
  const cursorWhere = c
    ? {
        OR: [
          { createdAt: { lt: c.createdAt } },
          { AND: [{ createdAt: c.createdAt }, { id: { lt: c.id } }] },
        ],
      }
    : undefined;

  try {
    return await prisma.$transaction(async (tx) => {
      // set rls session context
      await setActorContext(tx, { actorId: dto.actorId, role: dto.actorRole });

      // scope favorites by actor kind
      const actorWhere =
        dto.actorRole === 'GUEST'
          ? { guestId: dto.actorId as string }
          : { userId: Number(dto.actorId) };

      // the list of a buyer: a variant the buyer does not see is left out, the favorite itself stays
      const baseWhere: Prisma.FavoriteWhereInput = { ...actorWhere, variant: BUYER_VARIANT };

      // apply cursor window when provided
      const finalWhere = cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere;

      // fetch to detect next page
      const rows = await tx.favorite.findMany({
        where: finalWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: { id: true, createdAt: true, productId: true, variantId: true },
      });

      const hasNext = rows.length > limit;
      const pageRows = hasNext ? rows.slice(0, limit) : rows;

      // the products and the variants of the page, each read apart (a query reads at most two
      // relations side by side), put in the order of the favorites
      const products = await tx.product.findMany({
        where: { id: { in: [...new Set(pageRows.map((row) => row.productId))] } },
        select: productResponseSelect,
      });
      const variants = await tx.productVariant.findMany({
        where: { id: { in: pageRows.map((row) => row.variantId) } },
        select: variantRowSelect,
      });
      const context = await readVariantContext(tx, variants, 'buyer');

      const productById = new Map(products.map((row) => [row.id, row]));
      const variantById = new Map(variants.map((row) => [row.id, row]));

      const items = pageRows.flatMap((row) => {
        const product = productById.get(row.productId);
        const variant = variantById.get(row.variantId);
        // a row that vanished between the two reads (the variant is deleted for good) is left out
        if (!product || !variant) return [];

        return [
          {
            // the product as a list of a buyer shows it, and the variant the buyer likes
            product: mapProductListPart(product, 'buyer'),
            variant: variantShortOf(variant, context, 'buyer'),
            addedAt: row.createdAt,
          },
        ];
      });

      const last = pageRows.length ? pageRows[pageRows.length - 1] : null;

      // next cursor from last row
      const nextCursor =
        hasNext && last ? encodeCursor({ id: last.id, v: last.createdAt.toISOString() }) : null;

      return { items, nextCursor };
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'FAVORITES_FIND_UNEXPECTED' }, err);
  }
}

// whether a failure of the database says the variant is not one to keep: the triggers that refuse a
// new favorite of a variant or a product taken out, the foreign key of a variant that is gone
function isMissingVariant(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') return true;

  const message = `${getPgMessage(err) ?? ''} ${(err as Error)?.message ?? ''}`;
  return message.includes('VARIANT_NOT_FOUND') || message.includes('PRODUCT_NOT_FOUND');
}

async function addFavorite(dto: AddFavoriteDto): Promise<AddFavoriteResponseDto> {
  // idempotent add favorite for actor
  const { actorId, actorRole, variantId } = dto;

  if (!Number.isInteger(variantId) || variantId <= 0) {
    throw new BadRequestError('VARIANT_ID_INVALID');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // set rls session context
      await setActorContext(tx, { actorId, role: actorRole });

      // a favorite is a variant a buyer sees; the product it belongs to is kept beside it
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, ...BUYER_VARIANT },
        select: { id: true, productId: true },
      });
      if (!variant) throw new NotFoundError('VARIANT_NOT_FOUND', { variantId });

      // write favorite row by actor kind; the same variant again is kept once
      const owner =
        actorRole === 'GUEST' ? { guestId: actorId as string } : { userId: Number(actorId) };
      try {
        await tx.favorite.createMany({
          data: [{ ...owner, productId: variant.productId, variantId: variant.id }],
          skipDuplicates: true,
        });
      } catch (err) {
        // the variant went out of sale between the read and the write
        if (isMissingVariant(err)) throw new NotFoundError('VARIANT_NOT_FOUND', { variantId });

        throw err;
      }

      return { variantId, isFavorite: true as const };
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'FAVORITES_ADD_UNEXPECTED' }, err);
  }
}

async function deleteFavorite(dto: DeleteFavoriteDto): Promise<DeleteFavoriteResponseDto> {
  // idempotent remove favorite for actor
  const { actorId, actorRole, variantId } = dto;

  try {
    await prisma.$transaction(async (tx) => {
      // set rls session context
      await setActorContext(tx, { actorId, role: actorRole });

      if (actorRole === 'GUEST') {
        await tx.favorite.deleteMany({ where: { guestId: actorId as string, variantId } });
        return;
      }

      const userId = typeof actorId === 'number' ? actorId : Number(actorId);
      await tx.favorite.deleteMany({ where: { userId, variantId } });
    });

    return { variantId, isFavorite: false };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'FAVORITES_DELETE_UNEXPECTED' }, err);
  }
}

export const favoritesServices = {
  findFavorites,
  addFavorite,
  deleteFavorite,
};

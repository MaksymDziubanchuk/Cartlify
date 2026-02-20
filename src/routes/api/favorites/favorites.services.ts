import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import { encodeCursor, decodeCursor } from '@helpers/codeCursor.js';
import { assertLimit } from '@helpers/assertLimit.js';
import { mapProductListRowToResponse } from '../products/services/helpers/getAllProducts.helper.js';

import { BadRequestError, NotFoundError, isAppError, AppError } from '@utils/errors.js';
import type {
  FindFavoritesDto,
  GetFavoritesResponseDto,
  AddFavoriteDto,
  AddFavoriteResponseDto,
  DeleteFavoriteDto,
  DeleteFavoriteResponseDto,
} from 'types/dto/favorites.dto.js';

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
          if (Number.isNaN(d.getTime())) throw new AppError('CURSOR_INVALID', 400);
          return { id: cRaw.id, createdAt: d };
        })()
      : cRaw
        ? (() => {
            throw new AppError('CURSOR_INVALID', 400);
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

      const baseWhere: any = {
        ...actorWhere,
        product: { deletedAt: null },
      };

      // apply cursor window when provided
      const finalWhere = cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere;

      // fetch limit+1 to detect next page
      const rows = await tx.favorite.findMany({
        where: finalWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          createdAt: true,
          product: {
            select: {
              id: true,
              name: true,
              description: true,
              price: true,
              stock: true,
              categoryId: true,
              views: true,
              popularity: true,
              avgRating: true,
              reviewsCount: true,
              createdAt: true,
              updatedAt: true,
              deletedAt: true,
              images: {
                where: { isPrimary: true },
                select: { url: true, position: true, isPrimary: true },
                orderBy: { position: 'asc' },
                take: 1,
              },
            },
          },
        },
      });

      const hasNext = rows.length > limit;
      const pageRows = hasNext ? rows.slice(0, limit) : rows;

      // map favorites into product cards
      const items = pageRows.map((r) => ({
        product: mapProductListRowToResponse(r.product as any),
        addedAt: r.createdAt,
      }));

      const last = pageRows.length ? pageRows[pageRows.length - 1] : null;

      // derive next cursor from last row
      const nextCursor =
        hasNext && last ? encodeCursor({ id: last.id, v: last.createdAt.toISOString() }) : null;

      return { items, nextCursor };
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new AppError('favorites.findFavorites: unexpected', 500);
  }
}

async function addFavorite(dto: AddFavoriteDto): Promise<AddFavoriteResponseDto> {
  // idempotent add favorite for actor
  const { actorId, actorRole, productId } = dto;

  if (productId == null || !Number.isInteger(productId) || productId <= 0) {
    throw new BadRequestError('PRODUCT_ID_INVALID');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // set rls session context
      await setActorContext(tx, { actorId, role: actorRole });

      // enforce not deleted product
      const exists = await tx.product.findFirst({
        where: { id: productId, deletedAt: null },
        select: { id: true },
      });
      if (!exists) throw new NotFoundError('PRODUCT_NOT_FOUND');

      try {
        // write favorite row by actor kind
        if (actorRole === 'GUEST') {
          await tx.favorite.create({
            data: { guestId: actorId as string, productId },
          });
        } else {
          const userId = typeof actorId === 'number' ? actorId : Number(actorId);
          await tx.favorite.create({
            data: { userId, productId },
          });
        }
      } catch (err) {
        // treat unique conflict as already favorited
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return { productId, isFavorite: true };
        }

        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
          throw new NotFoundError('PRODUCT_NOT_FOUND');
        }

        throw err;
      }

      return { productId, isFavorite: true };
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new AppError('favorites.addFavorite: unexpected', 500);
  }
}

async function deleteFavorite(dto: DeleteFavoriteDto): Promise<DeleteFavoriteResponseDto> {
  // idempotent remove favorite for actor
  const { actorId, actorRole, productId } = dto;

  try {
    await prisma.$transaction(async (tx) => {
      // set rls session context
      await setActorContext(tx, { actorId, role: actorRole });

      if (actorRole === 'GUEST') {
        await tx.favorite.deleteMany({ where: { guestId: actorId as string, productId } });
        return;
      }

      const userId = typeof actorId === 'number' ? actorId : Number(actorId);
      await tx.favorite.deleteMany({ where: { userId, productId } });
    });

    return { productId, isFavorite: false };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new AppError('favorites.deleteFavorite: unexpected', 500);
  }
}

export const favoritesServices = {
  findFavorites,
  addFavorite,
  deleteFavorite,
};

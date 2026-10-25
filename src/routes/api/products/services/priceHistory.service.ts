import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import { normalizeFindProductByIdInput } from './helpers/index.js';

import type { PriceHistoryDto, PriceHistoryResponseDto } from 'types/dto/products.dto.js';
import type { UserId } from 'types/ids.js';

// the history of the price of a product for admin and root: each change of the price, the start
// of each sale and each sale taken off, with who did it, the newest first (the log of prices,
// cartlify.log_product_price_change); a product taken out of the catalog keeps its history
export async function findPriceHistory(dto: PriceHistoryDto): Promise<PriceHistoryResponseDto> {
  assertAdminActor(dto.actorId, dto.actorRole);
  const { productId } = normalizeFindProductByIdInput(dto);
  const limit = dto.limit ?? 50;

  const cursor = dto.cursor ? (decodeCursor(dto.cursor) as { id: number; s?: unknown }) : null;
  if (cursor && cursor.s !== 'id:desc') throw new BadRequestError('CURSOR_INVALID');

  try {
    const rows = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: dto.actorId, role: dto.actorRole });

      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');

      return tx.productPriceChangeLog.findMany({
        where: { productId, ...(cursor ? { id: { lt: cursor.id } } : {}) },
        orderBy: { id: 'desc' },
        take: limit + 1,
        select: {
          id: true,
          oldPrice: true,
          newPrice: true,
          mode: true,
          value: true,
          endsAt: true,
          createdAt: true,
          actor: { select: { id: true, name: true, deletedAt: true } },
        },
      });
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        oldPrice: decimalToNumber(row.oldPrice),
        newPrice: decimalToNumber(row.newPrice),
        mode: row.mode,
        value: decimalToNumber(row.value),
        // the start of a sale names its end
        endsAt: row.endsAt ? row.endsAt.toISOString() : null,
        actor: {
          id: row.actor.id as UserId,
          name: row.actor.name,
          deleted: row.actor.deletedAt !== null,
        },
        createdAt: row.createdAt.toISOString(),
      })),
      limit,
      nextCursor:
        rows.length > limit && last ? encodeCursor({ id: last.id, s: 'id:desc' } as never) : null,
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'PRODUCTS_PRICE_HISTORY_UNEXPECTED' }, err);
  }
}

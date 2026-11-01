import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { variantNamesOf } from '@db/variantNames.helper.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { HIDDEN_ID, hiddenText } from '@helpers/rootHidden.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import { normalizeFindProductByIdInput } from './helpers/index.js';

import type { PriceHistoryDto, PriceHistoryResponseDto } from 'types/dto/products.dto.js';
import type { UserId } from 'types/ids.js';

// the history of the price of a product for admin and root: each change of the price of each of its
// variants, the start of each sale and each sale taken off, with who did it and the variant it is
// about, the newest first (the log of prices, cartlify.log_variant_price_change). `variantId`
// keeps the changes of one variant of the product. A product taken out of the catalog keeps its
// history, so does a variant taken out of sale
export async function findPriceHistory(dto: PriceHistoryDto): Promise<PriceHistoryResponseDto> {
  assertAdminActor(dto.actorId, dto.actorRole);
  const { productId } = normalizeFindProductByIdInput(dto);
  const limit = dto.limit ?? 50;

  const cursor = dto.cursor ? (decodeCursor(dto.cursor) as { id: number; s?: unknown }) : null;
  if (cursor && cursor.s !== 'id:desc') throw new BadRequestError('CURSOR_INVALID');

  try {
    const { rows, names, productName } = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: dto.actorId, role: dto.actorRole });

      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true },
      });
      if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');

      if (dto.variantId !== undefined) {
        const variant = await tx.productVariant.findFirst({
          where: { id: dto.variantId, productId },
          select: { id: true },
        });
        if (!variant) throw new NotFoundError('VARIANT_NOT_FOUND');
      }

      const found = await tx.productPriceChangeLog.findMany({
        where: {
          productId,
          ...(dto.variantId !== undefined ? { variantId: dto.variantId } : {}),
          ...(cursor ? { id: { lt: cursor.id } } : {}),
        },
        orderBy: { id: 'desc' },
        take: limit + 1,
        // two relations at most in a query of a transaction: the product is the one of the route,
        // its name is read above (Prisma loads the relations of a query side by side, and a
        // transaction has one connection: pg@9 refuses a second statement while one runs)
        select: {
          id: true,
          variant: { select: { id: true, position: true, sku: true } },
          oldPrice: true,
          newPrice: true,
          mode: true,
          value: true,
          endsAt: true,
          event: true,
          createdAt: true,
          actor: { select: { id: true, name: true, role: true, deletedAt: true } },
        },
      });

      // the names the variants have now (one query for the page)
      const names = await variantNamesOf(
        tx,
        found.slice(0, limit).map((row) => row.variant.id),
      );

      return { rows: found, names, productName: product.name };
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        variant: {
          id: row.variant.id,
          position: row.variant.position,
          name: names.get(row.variant.id)?.name ?? productName,
          sku: row.variant.sku,
        },
        oldPrice: decimalToNumber(row.oldPrice),
        newPrice: decimalToNumber(row.newPrice),
        mode: row.mode,
        value: decimalToNumber(row.value),
        // the start of a sale names its end
        endsAt: row.endsAt ? row.endsAt.toISOString() : null,
        // what made the line
        event: row.event,
        // who did it, with the role; an admin does not see who root is: its id is 0, its name hidden
        actor:
          row.actor.role === 'ROOT' && dto.actorRole !== 'ROOT'
            ? {
                id: HIDDEN_ID as UserId,
                name: hiddenText(row.actor.name),
                role: row.actor.role,
                deleted: row.actor.deletedAt !== null,
              }
            : {
                id: row.actor.id as UserId,
                name: row.actor.name,
                role: row.actor.role,
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

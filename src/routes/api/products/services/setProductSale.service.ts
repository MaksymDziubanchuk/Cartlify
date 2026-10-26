import { expiredUnitsNow } from '@db/expiredStock.helper.js';
import { lastUnitCostsNow } from '@db/lastUnitCost.helper.js';
import { Prisma } from '@prisma/client';
import { getPgMessage, tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { isSaleOn } from '@helpers/productSale.js';

import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';

import {
  mapProductRowToResponse,
  readCategoryPath,
  normalizeFindProductByIdInput,
  normalizeSaleEnd,
  productResponseSelect,
  putSaleOn,
  readProductImageUrls,
  takeSaleOff,
} from './helpers/index.js';

import type { SetProductSaleDto, SetProductSaleResponseDto } from 'types/dto/products.dto.js';

// puts a product on sale until an end in the future, or takes its sale off (sale null). The
// database keeps the sale price: while the sale lasts the product sells at it (db/05). A new sale
// writes over the one there is, an ended one too. The log of prices gets the start of a sale (from
// the price to the sale price in the mode of the discount, its size negative, and the end) and a
// sale taken off while it was on (from the sale price back to the price, by an amount); the admin
// log gets each of them as a sale (PRODUCT_SALE): start, change or removed. A sale that was over
// is no sale: a new one over it starts. The sale that is on already, or taking off a sale there is
// not, is done already: 409 and nothing is written
export async function setProductSale({
  productId,
  actorId,
  actorRole,
  sale,
}: SetProductSaleDto): Promise<SetProductSaleResponseDto> {
  assertAdminActor(actorId, actorRole);

  const { productId: id } = normalizeFindProductByIdInput({ productId });

  // a sale starts right away, its end is in the future
  const endsAt = sale ? normalizeSaleEnd(sale.endsAt) : null;

  try {
    const updated = await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // the price the sale is counted from cannot change until the sale is written
        await db.$queryRaw`SELECT id FROM cartlify.products WHERE id = ${id} FOR UPDATE`;

        const before = await db.product.findUnique({
          where: { id },
          select: productResponseSelect,
        });
        // a product removed from the catalog sells no more, a sale of it is no use
        if (!before || before.deletedAt) throw new NotFoundError('PRODUCT_NOT_FOUND');

        const ctx = { db, actorId, actorRole };

        // no sale to take off, a sale that is over is none: done already, nothing is written
        if (!sale) {
          if (!isSaleOn(before)) throw new ConflictError('PRODUCT_SALE_ALREADY_REMOVED');
          return takeSaleOff(ctx, before);
        }

        return putSaleOn(ctx, before, sale, endsAt!);
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );

    const images = await readProductImageUrls(updated.id as any);
    const expired = await expiredUnitsNow([updated.id]);
    const costs = await lastUnitCostsNow({ actorId, actorRole }, [updated.id]);

    return mapProductRowToResponse({
      product: {
        ...updated,
        expiredStock: expired.get(updated.id) ?? 0,
        lastUnitCost: costs.get(updated.id) ?? null,
      },
      images,
      categoryPath: await readCategoryPath(updated.category.id),
      view: 'admin',
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) throw new ResourceBusyError();

    // the end went by between the check and the write, by the clock of the database (db/05)
    if (String(getPgMessage(err) ?? '').includes('PRODUCT_SALE_ENDS_AT_INVALID')) {
      throw new BadRequestError('PRODUCT_SALE_ENDS_AT_INVALID');
    }

    throw new InternalError({ reason: 'PRODUCTS_SALE_UNEXPECTED' }, err);
  }
}

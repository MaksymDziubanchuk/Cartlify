import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { isSaleOn } from '@helpers/productSale.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { expiredUnitsOf, freeUnits } from '@db/expiredStock.helper.js';

import { InternalError, BadRequestError, ConflictError, isAppError } from '@utils/errors.js';

import {
  writeProductPriceChangeLog,
  normalizeBulkUpdateProductsPriceInput,
  takeSaleOff,
} from './helpers/index.js';

import type {
  BulkUpdateProductsPriceDto,
  BulkUpdateProductsPriceResponseDto,
} from 'types/dto/products.dto.js';
import type { AuditChange } from '@db/adminAudit.helper.js';

// the new price of a row: a percent of it or an amount on it, in cents, half up, counted in
// decimals: 1.15 plus 10 percent is 1.265 and 1.27, in floating point it was 1.2649999 and 1.26
const newPriceOf = (price: Prisma.Decimal, mode: 'percent' | 'fixed', value: number) => {
  const after =
    mode === 'fixed'
      ? price.plus(value)
      : price.times(new Prisma.Decimal(100).plus(value)).dividedBy(100);
  return after.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
};

// the prices of many products at once. Their sales that are on get one word for all: keep them,
// or take them off; a new sale is set product by product. Taken off, each goes the way of one
// product: the sale off with its lines, then the price. All of it or nothing
export async function updateProductsBulkPrice(
  dto: BulkUpdateProductsPriceDto,
): Promise<BulkUpdateProductsPriceResponseDto> {
  // validate actor context for admin-only action
  assertAdminActor(dto.actorId, dto.actorRole);

  // normalize inputs and build where outside tx
  const { mode, value, where, inStock, dryRun, reason, sale } = normalizeBulkUpdateProductsPriceInput({
    mode: dto.mode,
    value: dto.value,
    scope: dto.scope,
    dryRun: dto.dryRun,
    reason: dto.reason,
    sale: dto.sale,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: dto.actorId, role: dto.actorRole });

      // load matching rows to compute per-row price changes
      const matching = await tx.product.findMany({
        where,
        select: {
          id: true,
          price: true,
          salePrice: true,
          saleEndsAt: true,
          stock: true,
          reservedStock: true,
        },
      });

      // in stock means free units, as in the catalog: the stock less what the waiting orders hold
      // and the units over; without the word every product of the scope changes, the ones in carts
      // and the ones with units over too
      const expired =
        inStock === undefined ? null : await expiredUnitsOf(tx, matching.map((row) => row.id));
      const rows =
        inStock === undefined
          ? matching
          : matching.filter(
              (row) =>
                freeUnits(row.stock, row.reservedStock, expired!.get(row.id) ?? 0) > 0 === inStock,
            );

      // dry run returns only how many rows match
      if (dryRun) {
        return { message: 'DRY_RUN', updatedCount: rows.length };
      }

      const changes = rows.map((row) => ({ row, afterNum: newPriceOf(row.price, mode, value) }));

      // do not allow negative prices
      if (changes.some((change) => change.afterNum < 0)) {
        throw new BadRequestError('BULK_PRICE_NEGATIVE_RESULT');
      }

      // the sales that are on in the scope need a word, the same for all of them
      const onSale = changes.filter((change) => isSaleOn(change.row));
      if (onSale.length && sale === undefined) {
        throw new ConflictError('PRODUCT_SALE_DECISION_REQUIRED', {
          products: onSale.map(({ row }) => ({
            productId: row.id,
            salePrice: decimalToNumber(row.salePrice),
            saleEndsAt: row.saleEndsAt!.toISOString(),
          })),
        });
      }

      // a sale stays below the price: a new price down to it cannot keep it, and no product changes
      if (sale === 'keep') {
        const blocked = onSale.filter(
          ({ row, afterNum }) => afterNum <= decimalToNumber(row.salePrice),
        );
        if (blocked.length) {
          throw new ConflictError('PRODUCT_SALE_NOT_BELOW_PRICE', {
            products: blocked.map(({ row, afterNum }) => ({
              productId: row.id,
              salePrice: decimalToNumber(row.salePrice),
              price: afterNum,
            })),
          });
        }
      }

      const saleContext = { db: tx, actorId: dto.actorId, actorRole: dto.actorRole };

      // apply per-row updates to keep logs accurate
      let updatedCount = 0;

      for (const { row, afterNum } of changes) {
        // the sale goes first, with its lines, the way it goes for one product
        if (sale === 'remove' && isSaleOn(row)) await takeSaleOff(saleContext, row);

        // skip no-op to reduce writes and logs
        if (afterNum === Number(row.price.toString())) continue;

        const afterDec = new Prisma.Decimal(afterNum);

        // update row price
        await tx.product.update({
          where: { id: row.id },
          data: { price: afterDec },
          select: { id: true },
        });

        // write price change log for audit trail
        await writeProductPriceChangeLog(tx, {
          productId: row.id as any,
          beforePrice: row.price,
          afterPrice: afterDec,
          mode,
          value,
        });

        updatedCount++;
      }

      // log one admin action for the whole bulk operation
      const auditChanges: AuditChange[] = [
        { field: 'mode', old: null, new: mode },
        { field: 'value', old: null, new: value },
        { field: 'where', old: null, new: where },
        { field: 'updatedCount', old: null, new: updatedCount },
        ...(sale ? [{ field: 'sale', old: null, new: sale }] : []),
        ...(reason ? [{ field: 'reason', old: null, new: reason }] : []),
      ];

      await writeAdminAuditLog(tx, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        entityType: 'product',
        entityId: 0,
        action: 'PRODUCT_PRICE_BULK_UPDATE',
        changes: auditChanges,
      });

      return { message: 'PRODUCTS_PRICE_BULK_UPDATED', updatedCount };
    });
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_BULK_PRICE_UPDATE_UNEXPECTED' }, err);
  }
}

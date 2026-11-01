import { Prisma } from '@prisma/client';

import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { expiredUnitsOf, freeUnits } from '@db/expiredStock.helper.js';
import { variantNamesOf } from '@db/variantNames.helper.js';
import {
  characteristicFilterSql,
  resolveCharacteristicFilter,
} from '@helpers/characteristicFilter.js';
import { isSaleOn } from '@helpers/productSale.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { BadRequestError, ConflictError } from '@utils/errors.js';

import {
  normalizeBulkUpdateProductsPriceInput,
  takeSaleOff,
  writeVariantPriceChangeLog,
} from './helpers/index.js';
import { inVariantTx, lockVariants } from './helpers/variantTx.helper.js';

import type {
  BulkUpdateProductsPriceDto,
  BulkUpdateProductsPriceResponseDto,
} from 'types/dto/products.dto.js';
import { moneyField } from '@schemas/dto/products.dtoSchemas.js';
import type { AuditChange } from '@db/adminAudit.helper.js';
import type { ProductId } from 'types/ids.js';

// the new price of a row: a percent of it or an amount on it, in cents, half up, counted in
// decimals: 1.15 plus 10 percent is 1.265 and 1.27, in floating point it was 1.2649999 and 1.26
const newPriceOf = (price: Prisma.Decimal, mode: 'percent' | 'fixed', value: number) => {
  const after =
    mode === 'fixed'
      ? price.plus(value)
      : price.times(new Prisma.Decimal(100).plus(value)).dividedBy(100);
  return after.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
};

// the prices of many variants at once, the variants that fit the filter of the scope (the category
// and its products, the ids, the usual price, free units, the characteristics `f` as the catalog
// reads them, taken out of sale or not). Their sales
// that are on get one word for all: keep them, or take them off; a new sale is set variant by
// variant. Taken off, each goes the way of one variant: the sale off with its lines, then the
// price. All of it or nothing. A dry run lists the variants with their old and new price
export async function updateProductsBulkPrice(
  dto: BulkUpdateProductsPriceDto,
): Promise<BulkUpdateProductsPriceResponseDto> {
  // normalize inputs and build where outside tx
  const { mode, value, where, characteristics, inStock, dryRun, reason, sale } =
    normalizeBulkUpdateProductsPriceInput({
      mode: dto.mode,
      value: dto.value,
      scope: dto.scope,
      dryRun: dto.dryRun,
      reason: dto.reason,
      sale: dto.sale,
    });
  const actor = { actorId: dto.actorId, actorRole: dto.actorRole };

  return inVariantTx(
    actor,
    'PRODUCTS_BULK_PRICE_UPDATE_UNEXPECTED',
    async (db) => {
      // the characteristics: the variants that have all of them, as the filter of the catalog finds
      // them (the entries are checked against the directory first)
      let scope = where;
      if (characteristics.length) {
        await resolveCharacteristicFilter(db, characteristics);
        const having = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
          SELECT v."id" AS id FROM "product_variants" v
          WHERE ${Prisma.join(characteristicFilterSql(characteristics, 'v'), ' AND ')}
        `);
        scope = { AND: [where, { id: { in: having.map((row) => row.id) } }] };
      }

      // the variants of the scope, locked by id so that their prices do not change meanwhile
      const scoped = await db.productVariant.findMany({
        where: scope,
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      await lockVariants(
        db,
        scoped.map((row) => row.id),
      );

      // load matching rows to compute per-row price changes
      const matching = await db.productVariant.findMany({
        where: { AND: [scope, { id: { in: scoped.map((row) => row.id) } }] },
        select: {
          id: true,
          productId: true,
          price: true,
          salePrice: true,
          saleEndsAt: true,
          salePriorPrice: true,
          stock: true,
          reservedStock: true,
          product: { select: { name: true } },
        },
        orderBy: { id: 'asc' },
      });

      // in stock means free units, as in the catalog: the stock less what the waiting orders hold
      // and the units over; without the word every variant of the scope changes, the ones in carts
      // and the ones with units over too
      const expired =
        inStock === undefined
          ? null
          : await expiredUnitsOf(
              db,
              matching.map((row) => row.id),
            );
      const rows =
        inStock === undefined
          ? matching
          : matching.filter(
              (row) =>
                freeUnits(row.stock, row.reservedStock, expired!.get(row.id) ?? 0) > 0 === inStock,
            );

      const changes = rows.map((row) => ({ row, afterNum: newPriceOf(row.price, mode, value) }));

      // a dry run lists what would change and stops; the checks below are the real run's
      if (dryRun) {
        const names = await variantNamesOf(
          db,
          rows.map((row) => row.id),
        );

        return {
          message: 'DRY_RUN',
          updatedCount: rows.length,
          variants: changes.map(({ row, afterNum }) => ({
            id: row.id,
            productId: row.productId as ProductId,
            name: names.get(row.id)?.name ?? row.product.name,
            oldPrice: decimalToNumber(row.price),
            newPrice: afterNum,
          })),
        };
      }

      // do not allow negative prices
      if (changes.some((change) => change.afterNum < 0)) {
        throw new BadRequestError('BULK_PRICE_NEGATIVE_RESULT');
      }

      // nor prices past what a variant holds (numeric(10, 2)): the database would refuse the write
      const tooLarge = changes.filter((change) => change.afterNum > moneyField.maximum);
      if (tooLarge.length) {
        throw new BadRequestError('BULK_PRICE_TOO_LARGE_RESULT', {
          variants: tooLarge.map(({ row, afterNum }) => ({ variantId: row.id, price: afterNum })),
          maximum: moneyField.maximum,
        });
      }

      // the sales that are on in the scope need a word, the same for all of them
      const onSale = changes.filter((change) => isSaleOn(change.row));
      if (onSale.length && sale === undefined) {
        throw new ConflictError('PRODUCT_SALE_DECISION_REQUIRED', {
          variants: onSale.map(({ row }) => ({
            variantId: row.id,
            salePrice: decimalToNumber(row.salePrice),
            saleEndsAt: row.saleEndsAt!.toISOString(),
          })),
        });
      }

      // a sale stays below the price: a new price down to it cannot keep it, and no variant changes
      if (sale === 'keep') {
        const blocked = onSale.filter(
          ({ row, afterNum }) => afterNum <= decimalToNumber(row.salePrice),
        );
        if (blocked.length) {
          throw new ConflictError('PRODUCT_SALE_NOT_BELOW_PRICE', {
            variants: blocked.map(({ row, afterNum }) => ({
              variantId: row.id,
              salePrice: decimalToNumber(row.salePrice),
              price: afterNum,
            })),
          });
        }
      }

      const saleContext = {
        db,
        ...actor,
        // a sale taken off with a price
        source: 'with_price' as const,
      };

      // apply per-row updates to keep logs accurate
      let updatedCount = 0;

      for (const { row, afterNum } of changes) {
        // the sale goes first, with its lines, the way it goes for one variant
        if (sale === 'remove' && isSaleOn(row)) await takeSaleOff(saleContext, row);

        // skip no-op to reduce writes and logs
        if (afterNum === Number(row.price.toString())) continue;

        const afterDec = new Prisma.Decimal(afterNum);

        // update row price
        await db.productVariant.update({
          where: { id: row.id },
          data: { price: afterDec },
          select: { id: true },
        });

        // write price change log for audit trail
        await writeVariantPriceChangeLog(db, {
          variantId: row.id,
          beforePrice: row.price,
          afterPrice: afterDec,
          mode,
          value,
          event: 'price.bulk',
        });

        updatedCount++;
      }

      // log one admin action for the whole bulk operation
      const auditChanges: AuditChange[] = [
        { field: 'mode', old: null, new: mode },
        { field: 'value', old: null, new: value },
        { field: 'where', old: null, new: where },
        ...(characteristics.length
          ? [{ field: 'f', old: null, new: characteristics.map((entry) => entry.entry) }]
          : []),
        { field: 'updatedCount', old: null, new: updatedCount },
        ...(sale ? [{ field: 'sale', old: null, new: sale }] : []),
        ...(reason ? [{ field: 'reason', old: null, new: reason }] : []),
      ];

      await writeAdminAuditLog(db, {
        ...actor,
        entityType: 'product',
        entityId: 0,
        action: 'PRODUCT_PRICE_BULK_UPDATE',
        event: 'product.price_bulk',
        changes: auditChanges,
      });

      return { message: 'PRODUCTS_PRICE_BULK_UPDATED', updatedCount };
    },
    { timeout: 60_000 },
  );
}

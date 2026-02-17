import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import { AppError, BadRequestError, isAppError } from '@utils/errors.js';

import {
  writeProductPriceChangeLog,
  normalizeBulkUpdateProductsPriceInput,
} from './helpers/index.js';

import type {
  BulkUpdateProductsPriceDto,
  BulkUpdateProductsPriceResponseDto,
} from 'types/dto/products.dto.js';
import type { AuditChange } from '@db/adminAudit.helper.js';

export async function updateProductsBulkPrice(
  dto: BulkUpdateProductsPriceDto,
): Promise<BulkUpdateProductsPriceResponseDto> {
  // validate actor context for admin-only action
  assertAdminActor(dto.actorId, dto.actorRole);

  // normalize inputs and build where outside tx
  const { mode, value, where, dryRun, reason } = normalizeBulkUpdateProductsPriceInput({
    mode: dto.mode,
    value: dto.value,
    scope: dto.scope,
    dryRun: dto.dryRun,
    reason: dto.reason,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: dto.actorId, role: dto.actorRole });

      // load matching rows to compute per-row price changes
      const rows = await tx.product.findMany({
        where,
        select: { id: true, price: true },
      });

      // dry run returns only how many rows match
      if (dryRun) {
        return { message: 'DRY_RUN', updatedCount: rows.length };
      }

      // apply per-row updates to keep logs accurate
      let updatedCount = 0;

      for (const row of rows) {
        const beforeNum = Number(row.price.toString());

        const afterNumRaw = mode === 'fixed' ? beforeNum + value : beforeNum * (1 + value / 100);

        // keep 2 decimals for money
        const afterNum = Math.round(afterNumRaw * 100) / 100;

        // do not allow negative prices
        if (afterNum < 0) throw new BadRequestError('BULK_PRICE_NEGATIVE_RESULT');

        // skip no-op to reduce writes and logs
        if (afterNum === beforeNum) continue;

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
          actorId: dto.actorId,
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

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`products.updateProductsBulkPrice: unexpected (${msg})`, 500);
  }
}

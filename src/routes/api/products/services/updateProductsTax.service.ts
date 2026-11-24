import { Prisma } from '@prisma/client';

import { writeAdminAuditLogs, type AuditChange } from '@db/adminAudit.helper.js';
import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError } from '@utils/errors.js';

import {
  assertTaxGroupsExist,
  normalizeTaxExceptions,
  sameExceptions,
  type TaxExceptions,
} from './helpers/productTax.helper.js';

import type { UpdateProductsTaxDto, UpdateProductsTaxResponseDto } from 'types/dto/products.dto.js';

// PATCH /api/products/tax: the tax group and the classes of the countries of many products at once
// (docs/taxes.md), the products that fit the scope (the ids, the category, the group, the class a
// country gives or does not give). Root adding a country sees which products a group or a class
// names (a dry run lists them with what they would have) and changes them together; all of them or
// none. A line of the admin log for each product that changes
export async function updateProductsTax(
  dto: UpdateProductsTaxDto,
): Promise<UpdateProductsTaxResponseDto> {
  assertAdminActor(dto.actorId, dto.actorRole);

  const exceptions = normalizeTaxExceptions(dto.exceptions) ?? {};
  const remove = [...new Set(dto.removeExceptions ?? [])];
  if (
    dto.taxGroupId === undefined &&
    !Object.keys(exceptions).length &&
    !remove.length &&
    !dto.dryRun
  ) {
    throw new BadRequestError('NO_FIELDS_TO_UPDATE');
  }
  const both = remove.filter((country) => country in exceptions);
  if (both.length) throw new BadRequestError('PRODUCT_TAX_EXCEPTION_TWICE', { countries: both });

  const { scope } = dto;

  return tx(async (db) => {
    await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });
    await assertTaxGroupsExist(db, dto.taxGroupId, exceptions);

    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      ...(scope.productIds ? { id: { in: scope.productIds } } : {}),
      ...(scope.categoryId !== undefined ? { categoryId: scope.categoryId } : {}),
      ...(scope.taxGroupId !== undefined ? { taxGroupId: scope.taxGroupId } : {}),
    };
    let products = await db.product.findMany({
      where,
      select: { id: true, name: true, taxGroupId: true, taxExceptions: true },
      orderBy: { id: 'asc' },
    });

    // the class a country gives a product, or none: a key of the object
    const classes = (p: { taxExceptions: unknown }) => (p.taxExceptions ?? {}) as TaxExceptions;
    if (scope.exceptionOf) products = products.filter((p) => scope.exceptionOf! in classes(p));
    if (scope.withoutExceptionOf) {
      products = products.filter((p) => !(scope.withoutExceptionOf! in classes(p)));
    }

    const changed = products.map((p) => {
      const next: TaxExceptions = { ...classes(p), ...exceptions };
      for (const country of remove) delete next[country];
      return {
        id: p.id,
        name: p.name,
        before: { taxGroupId: p.taxGroupId, taxExceptions: classes(p) },
        taxGroupId: dto.taxGroupId === undefined ? p.taxGroupId : dto.taxGroupId,
        taxExceptions: next,
      };
    });

    if (!dto.dryRun) {
      const lines: { entityId: number; changes: AuditChange[] }[] = [];

      // the rows by id, so two such requests wait for each other; each read again under its lock,
      // so a request that waited changes what the one before it wrote
      for (const p of changed) {
        const [kept] = await db.$queryRaw<{ taxGroupId: number | null; taxExceptions: unknown }[]>`
          select "taxGroupId", "taxExceptions" from cartlify.products where id = ${p.id} for update
        `;
        p.before = {
          taxGroupId: kept?.taxGroupId ?? null,
          taxExceptions: classes({ taxExceptions: kept?.taxExceptions ?? null }),
        };
        p.taxExceptions = { ...p.before.taxExceptions, ...exceptions };
        for (const country of remove) delete p.taxExceptions[country];
        if (dto.taxGroupId === undefined) p.taxGroupId = p.before.taxGroupId;
        const changes: AuditChange[] = [];
        if (p.taxGroupId !== p.before.taxGroupId) {
          changes.push({ field: 'taxGroupId', old: p.before.taxGroupId, new: p.taxGroupId });
        }
        if (!sameExceptions(p.before.taxExceptions, p.taxExceptions)) {
          changes.push({
            field: 'taxExceptions',
            old: p.before.taxExceptions,
            new: p.taxExceptions,
          });
        }
        if (!changes.length) continue;

        await db.product.update({
          where: { id: p.id },
          data: { taxGroupId: p.taxGroupId, taxExceptions: p.taxExceptions },
        });
        lines.push({ entityId: p.id, changes });
      }

      await writeAdminAuditLogs(db, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        entityType: 'product',
        action: 'PRODUCT_UPDATE',
        event: 'product.update_batch',
        lines,
      });
    }

    return {
      dryRun: dto.dryRun === true,
      count: changed.length,
      products: changed.map((p) => ({
        id: p.id,
        name: p.name,
        taxGroupId: p.taxGroupId,
        taxExceptions: p.taxExceptions,
      })),
    };
  });
}

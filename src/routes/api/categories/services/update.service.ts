import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { AppError, BadRequestError, NotFoundError, isAppError } from '@utils/errors.js';

import { normalizeFindCategoryByIdInput, normalizeUpdateCategoryInput } from './helpers/index.js';

import type { UpdateCategoryDto, UpdateCategoryResponseDto } from 'types/dto/categories.dto.js';

import type { AuditChange } from '@db/adminAudit.helper.js';

export async function updateCategory({
  categoryId,
  actorId,
  actorRole,
  name,
  slug,
  description,
  parentId,
}: UpdateCategoryDto): Promise<UpdateCategoryResponseDto> {
  // validate actor context for rls and admin-only update
  assertAdminActor(actorId, actorRole);

  // normalize and validate id
  const { categoryId: categoryIdRaw } = normalizeFindCategoryByIdInput({ categoryId });

  // normalize and validate provided fields
  const { nameNorm, slugNorm, descriptionNorm, parentIdNorm } = normalizeUpdateCategoryInput({
    name,
    slug,
    description,
    parentId,
  });

  // reject empty patch
  const hasAnyUpdates =
    name !== undefined || slug !== undefined || description !== undefined || parentId !== undefined;

  if (!hasAnyUpdates) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  // block parent self link
  if (parentIdNorm != null && parentIdNorm === categoryIdRaw) {
    throw new BadRequestError('CATEGORY_PARENT_ID_INVALID');
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // load previous state for audit
      const before = await tx.category.findUnique({
        where: { id: categoryIdRaw },
        select: { id: true, name: true, slug: true, description: true, parentId: true },
      });
      if (!before) throw new NotFoundError('CATEGORY_NOT_FOUND');

      // build update payload only for provided fields
      const data: Prisma.CategoryUpdateInput = {
        ...(name !== undefined ? { name: nameNorm! } : {}),
        ...(slug !== undefined ? { slug: slugNorm! } : {}),
        ...(description !== undefined ? { description: descriptionNorm ?? null } : {}),
        ...(parentId !== undefined ? { parentId: parentIdNorm ?? null } : {}),
      };

      const after = await tx.category.update({
        where: { id: categoryIdRaw },
        data,
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          parentId: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // build diff list only for fields present in input
      const changes: AuditChange[] = [];

      if (name !== undefined && before.name !== after.name) {
        changes.push({ field: 'name', old: before.name, new: after.name });
      }

      if (slug !== undefined && before.slug !== after.slug) {
        changes.push({ field: 'slug', old: before.slug, new: after.slug });
      }

      if (description !== undefined && before.description !== after.description) {
        changes.push({ field: 'description', old: before.description, new: after.description });
      }

      if (parentId !== undefined && before.parentId !== after.parentId) {
        changes.push({ field: 'parentId', old: before.parentId, new: after.parentId });
      }

      // write admin audit log when something actually changed
      if (changes.length) {
        await writeAdminAuditLog(tx, {
          actorId,
          actorRole,
          entityType: 'category',
          entityId: after.id,
          action: 'CATEGORY_UPDATE',
          changes,
        });
      }

      return after;
    });

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      ...(updated.description != null ? { description: updated.description } : {}),
      ...(updated.parentId != null ? { parentId: updated.parentId } : {}),
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  } catch (err) {
    // map unique slug conflict
    if (typeof err === 'object' && err !== null && 'code' in err && (err as any).code === 'P2002') {
      throw new AppError('CATEGORY_SLUG_TAKEN', 409);
    }

    // map invalid parentId foreign key
    if (typeof err === 'object' && err !== null && 'code' in err && (err as any).code === 'P2003') {
      throw new AppError('CATEGORY_PARENT_NOT_FOUND', 422);
    }

    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new AppError(`categories.update: unexpected`, 500);
  }
}

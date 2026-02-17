import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { AppError, isAppError } from '@utils/errors.js';
import { normalizeCreateCategoryInput } from './helpers/index.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import type { AuditChange } from '@db/adminAudit.helper.js';

import type { CreateCategoryDto, CreateCategoryResponseDto } from 'types/dto/categories.dto.js';

export async function createCategory({
  actorId,
  actorRole,
  name,
  slug,
  description,
  parentId,
}: CreateCategoryDto): Promise<CreateCategoryResponseDto> {
  // validate actor context for rls and admin-only create
  assertAdminActor(actorId, actorRole);

  // normalize and validate required scalar fields
  const { nameNorm, slugNorm, descriptionNorm, parentIdNorm } = normalizeCreateCategoryInput({
    name,
    slug,
    description,
    parentId,
  });

  // prepare audit changes list for create
  const auditChanges: AuditChange[] = [
    { field: 'name', old: null, new: nameNorm },
    { field: 'slug', old: null, new: slugNorm },
    { field: 'description', old: null, new: descriptionNorm },
    { field: 'parentId', old: null, new: parentIdNorm },
  ];

  try {
    // create category row and log admin action in one tx
    const created = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // create category row
      const category = await tx.category.create({
        data: {
          name: nameNorm,
          slug: slugNorm,
          description: descriptionNorm,
          parentId: parentIdNorm,
        },
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

      // write admin audit log for category create
      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'category',
        entityId: category.id,
        action: 'OTHER',
        changes: auditChanges,
      });

      return category;
    });

    // map db row into api dto
    return {
      id: created.id,
      name: created.name,
      slug: created.slug,
      ...(created.description ? { description: created.description } : {}),
      ...(created.parentId ? { parentId: created.parentId } : {}),
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('CATEGORY_SLUG_TAKEN', 409);
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      throw new AppError('CATEGORY_PARENT_NOT_FOUND', 422);
    }

    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`categories.create: unexpected (${msg})`, 500);
  }
}

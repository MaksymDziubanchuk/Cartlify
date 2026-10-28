import { prisma } from '@db/client.js';

import { normalizeDeleteCategoryInput } from './helpers/categories.helper.js';
import { setUserContext } from '@db/dbContext.service.js';
import { ConflictError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { deleteImage, isOwnFile } from '@utils/cloudinary.util.js';

import type { FastifyBaseLogger } from 'fastify';

import type { MessageResponseDto } from 'types/common.js';
import type { Role } from 'types/user.js';

export async function deleteCategoryById(dto: {
  categoryId: unknown;
  actorId: unknown;
  actorRole: Role;
  log?: Pick<FastifyBaseLogger, 'warn'>;
}): Promise<MessageResponseDto> {
  const { categoryId, actorId, actorRole } = normalizeDeleteCategoryInput(dto);

  try {
    const imagePublicId = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // load category for 404
      const before = await tx.category.findUnique({
        where: { id: categoryId },
        select: { id: true, parentId: true, imagePublicId: true },
      });
      if (!before) throw new NotFoundError('CATEGORY_NOT_FOUND');

      // deny delete when category has products
      const productsCount = await tx.product.count({ where: { categoryId } });
      if (productsCount > 0) throw new ConflictError('CATEGORY_HAS_PRODUCTS');

      // the direct children go to the parent of the category, or to the top, with their branches
      const children = await tx.category.findMany({
        where: { parentId: categoryId },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      if (children.length) {
        await tx.category.updateMany({
          where: { parentId: categoryId },
          data: { parentId: before.parentId },
        });
        for (const child of children) {
          await writeAdminAuditLog(tx, {
            actorId,
            actorRole,
            entityType: 'category',
            entityId: child.id,
            action: 'CATEGORY_UPDATE',
            event: 'category.reparent_on_delete',
            changes: [{ field: 'parentId', old: categoryId, new: before.parentId }],
          });
        }
      }

      // hard delete category row
      await tx.category.delete({ where: { id: categoryId } });

      // write admin audit log for category delete
      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'category',
        entityId: before.id,
        action: 'OTHER',
        event: 'category.delete',
        changes: [{ field: 'deleted', old: false, new: true }],
      });

      return before.imagePublicId;
    });

    // the category is gone: so is its picture. A failure is only logged, the file of no one stays
    if (isOwnFile(imagePublicId)) {
      try {
        await deleteImage(imagePublicId);
      } catch (err) {
        dto.log?.warn(
          { err, publicId: imagePublicId },
          'picture of a deleted category was not deleted',
        );
      }
    }

    return { message: 'CATEGORY_DELETED' };
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'CATEGORIES_DELETE_UNEXPECTED' }, err);
  }
}

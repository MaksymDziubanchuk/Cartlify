import { prisma } from '@db/client.js';

import { normalizeDeleteCategoryInput } from './helpers/categories.helper.js';
import { setUserContext } from '@db/dbContext.service.js';
import { AppError, NotFoundError, isAppError } from '@utils/errors.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import type { MessageResponseDto } from 'types/common.js';
import type { Role } from 'types/user.js';

export async function deleteCategoryById(dto: {
  categoryId: unknown;
  actorId: unknown;
  actorRole: Role;
}): Promise<MessageResponseDto> {
  const { categoryId, actorId, actorRole } = normalizeDeleteCategoryInput(dto);

  try {
    await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // load category for 404
      const before = await tx.category.findUnique({
        where: { id: categoryId },
        select: { id: true },
      });
      if (!before) throw new NotFoundError('CATEGORY_NOT_FOUND');

      // deny delete when category has products
      const productsCount = await tx.product.count({ where: { categoryId } });
      if (productsCount > 0) throw new AppError('CATEGORY_HAS_PRODUCTS', 409);

      // hard delete category row
      await tx.category.delete({ where: { id: categoryId } });

      // write admin audit log for category delete
      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'category',
        entityId: before.id,
        action: 'OTHER',
        changes: [{ field: 'deleted', old: false, new: true }],
      });
    });

    return { message: 'CATEGORY_DELETED' };
  } catch (err) {
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`categories.deleteCategoryById: unexpected (${msg})`, 500);
  }
}

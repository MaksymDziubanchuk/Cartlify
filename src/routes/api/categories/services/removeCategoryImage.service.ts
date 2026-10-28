import type { FastifyBaseLogger } from 'fastify';

import { prisma } from '@db/client.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { setUserContext } from '@db/dbContext.service.js';
import { deleteImage, isOwnFile } from '@utils/cloudinary.util.js';
import { ConflictError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import { categoryResponseOf } from './helpers/categories.helper.js';

import type { CategoryResponseDto } from 'types/dto/categories.dto.js';
import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

// takes the picture off a category: the row loses it, the file is deleted after the commit
export async function removeCategoryImage(dto: {
  categoryId: number;
  actorId: UserId;
  actorRole: Role;
  log: Pick<FastifyBaseLogger, 'warn'>;
}): Promise<CategoryResponseDto> {
  const { categoryId, actorId, actorRole, log } = dto;

  try {
    const { updated, oldPublicId } = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const before = await tx.category.findUnique({
        where: { id: categoryId },
        select: { id: true, imageUrl: true, imagePublicId: true },
      });
      if (!before) throw new NotFoundError('CATEGORY_NOT_FOUND');
      if (!before.imageUrl) throw new ConflictError('CATEGORY_IMAGE_NOT_SET');

      const updated = await tx.category.update({
        where: { id: categoryId },
        data: { imageUrl: null, imagePublicId: null },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          parentId: true,
          imageUrl: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'category',
        entityId: categoryId,
        action: 'CATEGORY_UPDATE',
        event: 'category.image_remove',
        changes: [{ field: 'image', old: before.imageUrl, new: null }],
      });

      return { updated, oldPublicId: before.imagePublicId };
    });

    if (isOwnFile(oldPublicId)) {
      try {
        await deleteImage(oldPublicId);
      } catch (err) {
        log.warn({ err, publicId: oldPublicId }, 'picture of a category was not deleted');
      }
    }

    return categoryResponseOf(updated);
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'CATEGORIES_IMAGE_REMOVE_UNEXPECTED' }, err);
  }
}

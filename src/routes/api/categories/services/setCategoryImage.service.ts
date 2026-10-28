import { randomUUID } from 'node:crypto';

import type { FastifyBaseLogger } from 'fastify';

import { prisma } from '@db/client.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  deleteImage,
  isOwnFile,
  makePublicId,
  makeUploadPublicId,
  moveImage,
  requireImageStream,
  uploadImage,
} from '@utils/cloudinary.util.js';
import { BadRequestError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import { categoryResponseOf } from './helpers/categories.helper.js';

import type {
  CategoryImagePart,
  CategoryResponseDto,
  UploadedCategoryImage,
} from 'types/dto/categories.dto.js';
import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

// reads the file of the form into Cloudinary at once, under an id of its own: setCategoryImage moves
// it to its place once the category is written, a refused request deletes it (the controller)
export async function beginCategoryImageUpload(args: {
  categoryId: number;
  image: CategoryImagePart;
}): Promise<UploadedCategoryImage> {
  const { categoryId, image } = args;

  // fast fail when the stream is already dead
  const stream: any = image.file;
  if (!stream || stream.destroyed || stream.readableEnded) {
    throw new BadRequestError('CATEGORY_IMAGE_EMPTY');
  }

  // an empty file and one that is not a jpeg, png or webp by its bytes never reach cloudinary
  const safeStream = await requireImageStream(image.file, {
    mimetype: image.mimetype,
    emptyCode: 'CATEGORY_IMAGE_STREAM_ERROR',
  });

  const uploaded = await uploadImage({
    publicId: makeUploadPublicId(),
    file: safeStream,
    mimetype: image.mimetype,
    ...(image.filename ? { filename: image.filename } : {}),
    tags: ['category', `category:${categoryId}`],
  });

  return { publicId: uploaded.publicId };
}

// puts the picture that waits on Cloudinary at the place of the category, replaces the one it had
// (deleted after the commit) and writes the change to the admin log
export async function setCategoryImage(dto: {
  categoryId: number;
  actorId: UserId;
  actorRole: Role;
  upload: Promise<UploadedCategoryImage>;
  log: Pick<FastifyBaseLogger, 'warn'>;
}): Promise<CategoryResponseDto> {
  const { categoryId, actorId, actorRole, log } = dto;
  const waiting = await dto.upload;

  // the file at its place, known to the catch below: a failure after the move leaves no one's file
  let placed: string | undefined;

  try {
    const { updated, oldPublicId } = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const before = await tx.category.findUnique({
        where: { id: categoryId },
        select: { id: true, imageUrl: true, imagePublicId: true },
      });
      if (!before) throw new NotFoundError('CATEGORY_NOT_FOUND');

      // a new path for every picture: the move never replaces the one the category shows, and
      // nothing of the path is cached to drop
      const moved = await moveImage(
        waiting.publicId,
        makePublicId({ kind: 'category', categoryId, imageKey: randomUUID() }),
        { invalidate: false },
      );
      placed = moved.publicId;

      const updated = await tx.category.update({
        where: { id: categoryId },
        data: { imageUrl: moved.urlBase, imagePublicId: moved.publicId },
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
        event: 'category.image_set',
        changes: [{ field: 'image', old: before.imageUrl, new: moved.urlBase }],
      });

      return { updated, oldPublicId: before.imagePublicId };
    });

    // the picture the category had is no one's now; a failure is only logged
    if (isOwnFile(oldPublicId)) {
      try {
        await deleteImage(oldPublicId);
      } catch (err) {
        log.warn({ err, publicId: oldPublicId }, 'old picture of a category was not deleted');
      }
    }

    return categoryResponseOf(updated);
  } catch (err) {
    if (placed) {
      try {
        await deleteImage(placed);
      } catch (deleteErr) {
        log.warn(
          { err: deleteErr, publicId: placed },
          'picture of a refused request was not deleted',
        );
      }
    }

    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'CATEGORIES_IMAGE_SET_UNEXPECTED' }, err);
  }
}

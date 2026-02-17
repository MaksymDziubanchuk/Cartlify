import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { AppError, NotFoundError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { normalizeFindProductByIdInput } from './helpers/index.js';

import type { DeleteProductByIdDto, DeleteProductByIdResponseDto } from 'types/dto/products.dto.js';

export async function deleteProductById(
  dto: DeleteProductByIdDto,
): Promise<DeleteProductByIdResponseDto> {
  // validate actor context for rls
  assertAdminActor(dto.actorId, dto.actorRole);

  const { productId } = normalizeFindProductByIdInput(dto);
  const { actorId, actorRole } = dto;

  try {
    await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // load product for 404 and idempotency check
      const before = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, deletedAt: true },
      });
      if (!before) throw new NotFoundError('PRODUCT_NOT_FOUND');

      // deny double delete
      if (before.deletedAt) throw new AppError('PRODUCT_ALREADY_DELETED', 409);

      // soft delete product row
      const after = await tx.product.update({
        where: { id: productId },
        data: { deletedAt: new Date() },
        select: { id: true, deletedAt: true },
      });

      // store deletedAt change in audit log
      const afterIso = after.deletedAt ? after.deletedAt.toISOString() : null;

      // write admin audit log for product delete
      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'product',
        entityId: after.id,
        action: 'PRODUCT_DELETE',
        changes: [{ field: 'deletedAt', old: null, new: afterIso }],
      });
    });

    return { message: 'PRODUCT_DELETED' };
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`products.deleteProductById: unexpected (${msg})`, 500);
  }
}

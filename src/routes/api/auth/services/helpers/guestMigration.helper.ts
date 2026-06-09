import { Prisma } from '@prisma/client';
import { setUserContext } from '@db/dbContext.service.js';
import { InternalError } from '@utils/errors.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

type Tx = Prisma.TransactionClient;

export async function migrateGuestDataToUser(
  tx: Tx,
  guestId: UserId,
  userId: UserId,
): Promise<void> {
  // load authenticated user role for RLS migration context
  const user = await tx.user.findUnique({
    where: {
      id: Number(userId),
    },
    select: {
      id: true,
      role: true,
    },
  });

  if (!user) {
    throw new InternalError({
      reason: 'GUEST_MIGRATION_USER_NOT_FOUND',
      userId,
    });
  }

  // switch transaction context to authenticated user before guest migration
  await setUserContext(tx, {
    userId: user.id,
    role: user.role as Role,
  });

  // migrate guest data to authenticated user
  await tx.$executeRaw`select cartlify.migrate_guest_data_to_user(
    ${guestId}::uuid,
    ${user.id}::int
  )`;
}
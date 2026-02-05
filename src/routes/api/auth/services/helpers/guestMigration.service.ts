import { Prisma } from '@prisma/client';
import type { UserId } from 'types/ids.js';

type Tx = Prisma.TransactionClient;

export async function migrateGuestDataToUser(
  tx: Tx,
  guestId: UserId,
  userId: UserId,
): Promise<void> {
  // migrate data guest to user
  await tx.$executeRaw`select cartlify.migrate_guest_data_to_user(
    ${guestId}::uuid,
    ${userId}::int
  )`;
}

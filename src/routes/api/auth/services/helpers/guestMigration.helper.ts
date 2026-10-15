import { Prisma } from '@prisma/client';
import { setUserContext } from '@db/dbContext.service.js';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

type Tx = Prisma.TransactionClient;

// switches the transaction to the user context and moves the guest data to the user;
// the context stays for the rest of the transaction, the caller goes on as this user
export async function migrateGuestDataToUser(
  tx: Tx,
  guestId: UserId,
  user: { id: UserId; role: Role },
): Promise<void> {
  // the caller already has the id and role from the database, a guest context could not read them
  await setUserContext(tx, {
    userId: user.id,
    role: user.role,
  });

  // migrate guest data to authenticated user; the db function checks that the context
  // user is this user, so the context switch above has to come first
  await tx.$executeRaw`select cartlify.migrate_guest_data_to_user(
    ${guestId}::uuid,
    ${Number(user.id)}::int
  )`;
}

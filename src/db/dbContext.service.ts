import { Prisma } from '@prisma/client';
import { AppError } from '@utils/errors.js';
import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

type Tx = Prisma.TransactionClient;

// set admin role without ids
export async function setAdminContext(tx: Tx): Promise<void> {
  await tx.$executeRaw`select cartlify.set_current_context(
    'ADMIN'::cartlify."Role",
    NULL,
    NULL
  )`;
}

// set guest role with guestId
export async function setGuestContext(tx: Tx, guestId: UserId): Promise<void> {
  if (!guestId) throw new AppError('GUEST_ID_REQUIRED', 400);

  await tx.$executeRaw`select cartlify.set_current_context(
    'GUEST'::cartlify."Role",
    NULL,
    ${guestId}::uuid
  )`;
}

// set user role with userId
export async function setUserContext(tx: Tx, args: { userId: UserId; role: Role }): Promise<void> {
  const { userId, role } = args;

  if (!userId || !Number.isInteger(userId)) throw new AppError('USER_ID_INVALID', 400);
  if (!role) throw new AppError('ROLE_REQUIRED', 400);

  // apply user context to tx
  await tx.$executeRaw`select cartlify.set_current_context(
    ${role}::cartlify."Role",
    ${userId}::int,
    NULL
  )`;
}

// set guest role with null ids
export async function setGuestNullContext(tx: Tx): Promise<void> {
  await tx.$executeRaw`select cartlify.set_current_context(
    'GUEST'::cartlify."Role",
    NULL,
    NULL
  )`;
}

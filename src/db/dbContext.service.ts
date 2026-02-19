import { Prisma } from '@prisma/client';
import { AppError } from '@utils/errors.js';
import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

type Tx = Prisma.TransactionClient;

// sets admin role without ids
export async function setAdminContext(tx: Tx): Promise<void> {
  await tx.$executeRaw`select cartlify.set_current_context(
    'ADMIN'::cartlify."Role",
    NULL,
    NULL
  )`;
}

// sets guest role with guestId (uuid)
export async function setGuestContext(tx: Tx, guestId: UserId): Promise<void> {
  if (!guestId) throw new AppError('GUEST_ID_REQUIRED', 400);

  await tx.$executeRaw`select cartlify.set_current_context(
    'GUEST'::cartlify."Role",
    NULL,
    ${guestId}::uuid
  )`;
}

// sets user context with numeric userId and explicit role (USER/ADMIN/ROOT)
export async function setUserContext(
  tx: Tx,
  args: { userId: UserId | string | number; role: Role },
): Promise<void> {
  const { userId, role } = args;

  if (role === null || role === undefined) throw new AppError('ROLE_REQUIRED', 400);

  // normalize userId to a positive integer (accepts number or numeric string)
  const idNum =
    typeof userId === 'number' ? userId : typeof userId === 'string' ? Number(userId) : Number.NaN;

  if (!Number.isInteger(idNum) || idNum <= 0) throw new AppError('USER_ID_INVALID', 400);

  // applies context used by RLS policies inside this transaction
  await tx.$executeRaw`select cartlify.set_current_context(
    ${role}::cartlify."Role",
    ${idNum}::int,
    NULL
  )`;
}

// sets guest role with null ids (public/anonymous read paths)
export async function setGuestNullContext(tx: Tx): Promise<void> {
  await tx.$executeRaw`select cartlify.set_current_context(
    'GUEST'::cartlify."Role",
    NULL,
    NULL
  )`;
}

// validates uuid guest ids coming from cookies/session
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

// parses positive integer ids from params/cookies (number or numeric string)
function parsePositiveInt(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isInteger(v) && v > 0 ? v : null;
  }
  if (typeof v === 'string') {
    if (!/^\d+$/.test(v)) return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

// chooses guest vs user context based on role and validates actorId shape
export async function setActorContext(
  tx: Tx,
  args: { actorId: unknown; role: Role },
): Promise<void> {
  const { actorId, role } = args;

  // guest actorId must be uuid
  if (role === 'GUEST') {
    if (!actorId) throw new AppError('GUEST_ID_REQUIRED', 400);
    if (!isUuid(actorId)) throw new AppError('GUEST_ID_INVALID', 400);

    await setGuestContext(tx, actorId as unknown as UserId);
    return;
  }

  // non-guest actorId must be a positive integer
  const userId = parsePositiveInt(actorId);
  if (userId === null) throw new AppError('USER_ID_INVALID', 400);

  await setUserContext(tx, { userId: userId as unknown as UserId, role });
}

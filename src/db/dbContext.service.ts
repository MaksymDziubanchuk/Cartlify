import { Prisma } from '@prisma/client';
import { currentRequest } from '@helpers/requestContext.js';
import { shopToday } from '@helpers/shopDay.js';
import { BadRequestError } from '@utils/errors.js';
import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

type Tx = Prisma.TransactionClient;

// every context carries the day of the shop for the transaction (cartlify.shop_today): it says
// which batches are over, it is no right of anybody, the policies never read it

// and the request it is done for: its address and its browser, the admin log keeps them with a
// line (cartlify.log_admin_action); no right of anybody either, empty without a request
const requestSettings = () => {
  const request = currentRequest();
  return Prisma.sql`, set_config('cartlify.request_ip', ${request?.ip ?? ''}, true), set_config('cartlify.request_user_agent', ${request?.userAgent ?? ''}, true)`;
};

// sets admin role without ids
export async function setAdminContext(tx: Tx): Promise<void> {
  await tx.$executeRaw`select cartlify.set_current_context(
    'ADMIN'::cartlify."Role",
    NULL,
    NULL
  ), set_config('cartlify.shop_today', ${shopToday()}, true)${requestSettings()}`;
}

// sets guest role with guestId (uuid)
export async function setGuestContext(tx: Tx, guestId: UserId): Promise<void> {
  if (!guestId) throw new BadRequestError('GUEST_ID_REQUIRED');

  await tx.$executeRaw`select cartlify.set_current_context(
    'GUEST'::cartlify."Role",
    NULL,
    ${guestId}::uuid
  ), set_config('cartlify.shop_today', ${shopToday()}, true)${requestSettings()}`;
}

// sets user context with numeric userId and explicit role (USER/ADMIN/ROOT)
export async function setUserContext(
  tx: Tx,
  args: { userId: UserId | string | number; role: Role },
): Promise<void> {
  const { userId, role } = args;

  if (role === null || role === undefined) throw new BadRequestError('ROLE_REQUIRED');

  // normalize userId to a positive integer (accepts number or numeric string)
  const idNum =
    typeof userId === 'number' ? userId : typeof userId === 'string' ? Number(userId) : Number.NaN;

  if (!Number.isInteger(idNum) || idNum <= 0) throw new BadRequestError('USER_ID_INVALID');

  // applies context used by RLS policies inside this transaction
  await tx.$executeRaw`select cartlify.set_current_context(
    ${role}::cartlify."Role",
    ${idNum}::int,
    NULL
  ), set_config('cartlify.shop_today', ${shopToday()}, true)${requestSettings()}`;
}

// sets guest role with null ids (public/anonymous read paths)
export async function setGuestNullContext(tx: Tx): Promise<void> {
  await tx.$executeRaw`select cartlify.set_current_context(
    'GUEST'::cartlify."Role",
    NULL,
    NULL
  ), set_config('cartlify.shop_today', ${shopToday()}, true)${requestSettings()}`;
}

// validates uuid guest ids coming from cookies/session
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
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
    if (!actorId) throw new BadRequestError('GUEST_ID_REQUIRED');
    if (!isUuid(actorId)) throw new BadRequestError('GUEST_ID_INVALID');

    await setGuestContext(tx, actorId as unknown as UserId);
    return;
  }

  // non-guest actorId must be a positive integer
  const userId = parsePositiveInt(actorId);
  if (userId === null) throw new BadRequestError('USER_ID_INVALID');

  await setUserContext(tx, { userId: userId as unknown as UserId, role });
}

// the day of the shop alone, for a read of the catalog without an actor: it says which batches
// are over (cartlify.shop_today)
export async function setShopDayContext(tx: Tx): Promise<void> {
  await tx.$executeRaw`select set_config('cartlify.shop_today', ${shopToday()}, true)`;
}

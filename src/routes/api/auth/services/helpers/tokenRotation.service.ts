import type { Prisma, Role, UserTokenType } from '@prisma/client';

import { AppError, ForbiddenError, UnauthorizedError } from '@utils/errors.js';
import { createPlaceholder } from '@utils/placeholder.js';
import { hashToken, verifyTokenHash } from '@utils/tokenHash.js';
import { signRefreshToken, signAccessToken, verifyRefreshToken } from '@utils/jwt.js';

export type Tx = Prisma.TransactionClient;

export type RefreshTokenRow = {
  id: number;
  userId: number;
  type: UserTokenType;
  token: string;
  expiresAt: Date;
  usedAt: Date | null;
};

// fetch refresh token row
export async function getRefreshTokenRow(tx: Tx, jwtId: number): Promise<RefreshTokenRow | null> {
  return tx.userToken.findUnique({
    where: { id: jwtId },
    select: {
      id: true,
      userId: true,
      type: true,
      token: true,
      expiresAt: true,
      usedAt: true,
    },
  });
}

// revoke all active refresh tokens
export async function revokeAllActiveRefreshTokens(
  tx: Tx,
  args: { userId: number; at: Date },
): Promise<void> {
  const { userId, at } = args;

  await tx.userToken.updateMany({
    where: { userId, type: 'REFRESH_TOKEN', usedAt: null },
    data: { usedAt: at },
  });
}

// mark single refresh token used
export async function markRefreshTokenUsed(
  tx: Tx,
  args: { jwtId: number; at: Date },
): Promise<void> {
  const { jwtId, at } = args;

  await tx.userToken.update({
    where: { id: jwtId },
    data: { usedAt: at },
  });
}

// compute cookie maxAge from deadline
// keep at least 1 second
export function calcFixedDeadlineMaxAgeSec(expiresAt: Date, now: Date): number {
  return Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
}

// create refresh token db row
// placeholder first, hash later
export async function createRefreshRowFixedDeadline(
  tx: Tx,
  args: { userId: number; expiresAt: Date },
): Promise<number> {
  const { userId, expiresAt } = args;

  const placeholder = createPlaceholder(32, 'hex');

  const created = await tx.userToken.create({
    data: {
      userId,
      type: 'REFRESH_TOKEN',
      token: placeholder,
      expiresAt,
    },
    select: { id: true },
  });

  const newJwtId = created?.id;
  if (!newJwtId) throw new AppError('refresh: failed to create refresh token row', 500);

  return newJwtId;
}

// store refresh token hash and exp
// no raw token stored in db
export async function storeRefreshHashFixedDeadline(
  tx: Tx,
  args: { jwtId: number; refreshToken: string; expiresAt: Date },
): Promise<void> {
  const { jwtId, refreshToken, expiresAt } = args;

  const refreshHash = hashToken(refreshToken);

  await tx.userToken.update({
    where: { id: jwtId },
    data: { token: refreshHash, expiresAt },
  });
}

// validate refresh row ownership and type
// reject mismatched user or token type
export function assertRefreshRowBasicsOrThrow(
  row: RefreshTokenRow,
  args: { userId: number },
): void {
  const { userId } = args;

  if (row.userId !== userId) throw new UnauthorizedError('refresh: token user mismatch');
  if (row.type !== 'REFRESH_TOKEN') throw new UnauthorizedError('refresh: wrong token type');
}

// block reused token and revoke all
// validate hash matches stored token
export async function assertNotReusedAndHashOkOrThrow(
  tx: Tx,
  args: {
    row: RefreshTokenRow;
    refreshToken: string;
    now: Date;
    userId: number;
    reuseMessage: string;
    hashMismatchMessage: string;
  },
): Promise<void> {
  const { row, refreshToken, now, userId, reuseMessage, hashMismatchMessage } = args;

  if (row.usedAt) {
    await revokeAllActiveRefreshTokens(tx, { userId, at: now });
    throw new ForbiddenError(reuseMessage);
  }

  const ok = verifyTokenHash(refreshToken, row.token);
  if (!ok) {
    await revokeAllActiveRefreshTokens(tx, { userId, at: now });
    throw new ForbiddenError(hashMismatchMessage);
  }
}

// block expired token in db
// consume token before throwing
export async function assertNotExpiredInDbOrThrow(
  tx: Tx,
  args: { row: RefreshTokenRow; now: Date; expiredMessage: string },
): Promise<void> {
  const { row, now, expiredMessage } = args;

  if (row.expiresAt.getTime() <= now.getTime()) {
    await markRefreshTokenUsed(tx, { jwtId: row.id, at: now });
    throw new UnauthorizedError(expiredMessage);
  }
}

// rotate refresh token (fixed deadline)
// mark old used, mint new, issue access
export async function rotateFixedDeadlineTokens(
  tx: Tx,
  args: {
    oldJwtId: number;
    sessionExpiresAt: Date;
    now: Date;
    user: { id: number; role: Role };
    rememberMe: boolean;
  },
): Promise<{
  accessToken: string;
  refreshToken: string;
  refreshMaxAgeSec: number;
}> {
  const { oldJwtId, sessionExpiresAt, now, user, rememberMe } = args;

  // compute refresh maxAge from deadline
  const refreshMaxAgeSec = calcFixedDeadlineMaxAgeSec(sessionExpiresAt, now);

  await markRefreshTokenUsed(tx, { jwtId: oldJwtId, at: now });

  // create new refresh row for deadline
  const newJwtId = await createRefreshRowFixedDeadline(tx, {
    userId: user.id,
    expiresAt: sessionExpiresAt,
  });

  // sign refresh token with new jwt id
  const newRefreshToken = signRefreshToken(
    { userId: user.id, role: user.role, type: 'refresh', jwtId: newJwtId, rememberMe },
    rememberMe,
  );

  // store refresh hash and expiresAt
  await storeRefreshHashFixedDeadline(tx, {
    jwtId: newJwtId,
    refreshToken: newRefreshToken,
    expiresAt: sessionExpiresAt,
  });

  // issue access token for session
  const accessToken = signAccessToken(
    { userId: user.id, role: user.role, type: 'access' },
    rememberMe,
  );

  return { accessToken, refreshToken: newRefreshToken, refreshMaxAgeSec };
}

// issue tokens on login flow
// create row, sign refresh, store hash
export async function issueTokensOnLogin(
  tx: Tx,
  args: { userId: number; role: Role; rememberMe: boolean },
): Promise<{ accessToken: string; refreshToken: string }> {
  const { userId, role, rememberMe } = args;

  // sign access token for response
  const accessToken = signAccessToken({ userId, role, type: 'access' }, rememberMe);

  const placeholder = createPlaceholder(32, 'hex');

  // create refresh row with placeholder
  const created = await tx.$queryRaw<{ id: number }[]>`
    insert into cartlify.user_tokens ("userId", type, token, "expiresAt")
    values (
      ${userId},
      'REFRESH_TOKEN'::cartlify."UserTokenType",
      ${placeholder},
      now() + interval '1 second'
    )
    returning id
  `;

  const jwtId = created[0]?.id;
  if (!jwtId) throw new AppError('Failed to create refresh token row', 500);

  // sign refresh token and read exp
  const refreshToken = signRefreshToken(
    { userId, role, type: 'refresh', jwtId, rememberMe },
    rememberMe,
  );

  // compute db expiresAt from jwt exp
  const { exp } = verifyRefreshToken(refreshToken);
  if (!exp) throw new AppError('Failed to decode refresh token exp', 500);

  // store refresh hash and expiresAt
  const refreshExpiresAt = new Date(exp * 1000);
  const refreshHash = hashToken(refreshToken);

  // update placeholder row with hash
  await tx.$executeRaw`
    update cartlify.user_tokens
    set token = ${refreshHash}, "expiresAt" = ${refreshExpiresAt}
    where id = ${jwtId}::int
  `;

  return { accessToken, refreshToken };
}

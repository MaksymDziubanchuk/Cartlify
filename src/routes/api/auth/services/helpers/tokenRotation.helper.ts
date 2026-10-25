import { randomUUID } from 'node:crypto';

import type { Prisma, Role, UserTokenType } from '@prisma/client';

import { ForbiddenError, InternalError, UnauthorizedError } from '@utils/errors.js';
import { createPlaceholder } from '@helpers/placeholder.js';
import { hashToken, verifyTokenHash } from '@helpers/tokenHash.js';
import { signRefreshToken, signAccessToken, verifyRefreshToken } from '@utils/jwt.js';

export type Tx = Prisma.TransactionClient;

export type RefreshTokenRow = {
  id: number;
  userId: number;
  type: UserTokenType;
  token: string;
  expiresAt: Date;
  usedAt: Date | null;
  // closed on purpose, not by a renewal
  revokedAt: Date | null;
  sessionId: string | null;
  userAgent: string | null;
};

// the browser a session is shown with, as long as a header of a browser may sensibly be
const USER_AGENT_MAX_LENGTH = 500;

export const sessionUserAgent = (userAgent: string | undefined): string | null =>
  userAgent?.trim().slice(0, USER_AGENT_MAX_LENGTH) || null;

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
      revokedAt: true,
      sessionId: true,
      userAgent: true,
    },
  });
}

// ends every open session of the user on purpose (a logout of all devices, a reset or a change of
// the password, a role change, a stolen token); a session kept is left open. A token closed so is
// a plain refusal when it comes back, no sign of theft
export async function revokeAllActiveRefreshTokens(
  tx: Tx,
  args: { userId: number; at: Date; keepSessionId?: string | null },
): Promise<void> {
  const { userId, at, keepSessionId } = args;

  await tx.userToken.updateMany({
    where: {
      userId,
      type: 'REFRESH_TOKEN',
      usedAt: null,
      ...(keepSessionId ? { NOT: { sessionId: keepSessionId } } : {}),
    },
    data: { usedAt: at, revokedAt: at },
  });
}

// ends one session on purpose: the logout of this browser, a session past its deadline
export async function revokeRefreshToken(tx: Tx, args: { jwtId: number; at: Date }): Promise<void> {
  const { jwtId, at } = args;

  await tx.userToken.update({
    where: { id: jwtId },
    data: { usedAt: at, revokedAt: at },
  });
}

// mark single refresh token used: its renewal, the token that follows it holds the session
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
  args: { userId: number; expiresAt: Date; sessionId: string; userAgent: string | null },
): Promise<number> {
  const { userId, expiresAt, sessionId, userAgent } = args;

  const placeholder = createPlaceholder(32, 'hex');

  const created = await tx.userToken.create({
    data: {
      userId,
      type: 'REFRESH_TOKEN',
      token: placeholder,
      expiresAt,
      sessionId,
      userAgent,
    },
    select: { id: true },
  });

  const newJwtId = created?.id;
  if (!newJwtId) throw new InternalError({ reason: 'REFRESH_TOKEN_ROW_CREATE_FAILED' });

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

  if (row.userId !== userId) throw new UnauthorizedError('REFRESH_TOKEN_USER_MISMATCH');
  if (row.type !== 'REFRESH_TOKEN') throw new UnauthorizedError('REFRESH_TOKEN_WRONG_TYPE');
}

// a session closed on purpose is a plain refusal and closes nothing more: the phone that kept the
// cookie of a session the reset of the password closed must not end the new one on the laptop.
// A token closed by its renewal coming back was copied: every session of the user is closed
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

  if (row.revokedAt) throw new UnauthorizedError('REFRESH_TOKEN_REVOKED');

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
// close the session before throwing, it ended and was not renewed
export async function assertNotExpiredInDbOrThrow(
  tx: Tx,
  args: { row: RefreshTokenRow; now: Date; expiredMessage: string },
): Promise<void> {
  const { row, now, expiredMessage } = args;

  if (row.expiresAt.getTime() <= now.getTime()) {
    await revokeRefreshToken(tx, { jwtId: row.id, at: now });
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
    // the session the old token belongs to: the new one goes on with it and its browser; a
    // session opened before sessions had ids gets one now
    sessionId: string | null;
    userAgent: string | null;
  },
): Promise<{
  accessToken: string;
  refreshToken: string;
  refreshMaxAgeSec: number;
}> {
  const { oldJwtId, sessionExpiresAt, now, user, rememberMe, sessionId, userAgent } = args;

  // compute refresh maxAge from deadline
  const refreshMaxAgeSec = calcFixedDeadlineMaxAgeSec(sessionExpiresAt, now);

  await markRefreshTokenUsed(tx, { jwtId: oldJwtId, at: now });

  // create new refresh row for deadline
  const newJwtId = await createRefreshRowFixedDeadline(tx, {
    userId: user.id,
    expiresAt: sessionExpiresAt,
    sessionId: sessionId ?? randomUUID(),
    userAgent,
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
  args: { userId: number; role: Role; rememberMe: boolean; userAgent?: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  const { userId, role, rememberMe } = args;

  // sign access token for response
  const accessToken = signAccessToken({ userId, role, type: 'access' }, rememberMe);

  const placeholder = createPlaceholder(32, 'hex');

  // create refresh row with placeholder
  // a new session, with the browser that opened it
  const created = await tx.$queryRaw<{ id: number }[]>`
    insert into cartlify.user_tokens ("userId", type, token, "expiresAt", "sessionId", "userAgent")
    values (
      ${userId},
      'REFRESH_TOKEN'::cartlify."UserTokenType",
      ${placeholder},
      now() + interval '1 second',
      ${randomUUID()}::uuid,
      ${sessionUserAgent(args.userAgent)}
    )
    returning id
  `;

  const jwtId = created[0]?.id;
  if (!jwtId) throw new InternalError({ reason: 'REFRESH_TOKEN_ROW_CREATE_FAILED' });

  // sign refresh token and read exp
  const refreshToken = signRefreshToken(
    { userId, role, type: 'refresh', jwtId, rememberMe },
    rememberMe,
  );

  // compute db expiresAt from jwt exp
  const { exp } = verifyRefreshToken(refreshToken);
  if (!exp) throw new InternalError({ reason: 'REFRESH_TOKEN_EXP_DECODE_FAILED' });

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

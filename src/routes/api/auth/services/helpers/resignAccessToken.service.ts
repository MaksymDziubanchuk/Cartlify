import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';
import { AppError, BadRequestError, UnauthorizedError } from '@utils/errors.js';
import { verifyRefreshToken } from '@utils/jwt.js';

import { setUserContext } from '@db/dbContext.service.js';

import {
  getRefreshTokenRow,
  assertRefreshRowBasicsOrThrow,
  assertNotReusedAndHashOkOrThrow,
  assertNotExpiredInDbOrThrow,
  rotateFixedDeadlineTokens,
} from './tokenRotation.service.js';

export type RefreshAccessDto = {
  refreshToken: string;
};

export type RefreshAccessResult = {
  accessToken: string;
  refreshToken: string;
  refreshMaxAgeSec: number;
  user: { id: number; role: Role };
  rememberMe: boolean;
};

// verify refresh token and db row
// block reuse or hash mismatch
// rotate refresh and issue new access
export async function refreshAccessTokenByRefreshToken({
  refreshToken,
}: RefreshAccessDto): Promise<RefreshAccessResult> {
  // validate refresh token input
  const rt = refreshToken?.trim();
  if (!rt) throw new BadRequestError('refresh: refreshToken required');

  // decode refresh token payload
  const { userId, role: tokenRole, jwtId, rememberMe } = verifyRefreshToken(rt);

  if (!Number.isInteger(userId) || userId <= 0)
    throw new UnauthorizedError('refresh: bad payload userId');
  if (!Number.isInteger(jwtId) || jwtId <= 0)
    throw new UnauthorizedError('refresh: bad payload jwtId');
  if (tokenRole === 'GUEST') throw new UnauthorizedError('refresh: guest token forbidden');

  // open tx and set db context
  return prisma
    .$transaction(async (tx) => {
      await setUserContext(tx, { userId, role: tokenRole });

      // load refresh token row
      const tokenRow = await getRefreshTokenRow(tx, jwtId);
      if (!tokenRow) throw new UnauthorizedError('refresh: token row not found');

      // basic token row checks
      assertRefreshRowBasicsOrThrow(tokenRow, { userId });

      const now = new Date();

      // block reuse and hash mismatch
      await assertNotReusedAndHashOkOrThrow(tx, {
        row: tokenRow,
        refreshToken: rt,
        now,
        userId,
        reuseMessage: 'refresh: token reuse detected',
        hashMismatchMessage: 'refresh: token hash mismatch',
      });

      // block expired token in db
      await assertNotExpiredInDbOrThrow(tx, {
        row: tokenRow,
        now,
        expiredMessage: 'refresh: token expired (db)',
      });

      // load user role from db
      const dbUser = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true },
      });

      if (!dbUser) throw new UnauthorizedError('refresh: user not found');
      if (dbUser.role === 'GUEST') throw new UnauthorizedError('refresh: guest forbidden');

      // rotate tokens with fixed deadline
      const rotated = await rotateFixedDeadlineTokens(tx, {
        oldJwtId: tokenRow.id,
        sessionExpiresAt: tokenRow.expiresAt,
        now,
        user: { id: dbUser.id, role: dbUser.role },
        rememberMe,
      });

      return {
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken,
        refreshMaxAgeSec: rotated.refreshMaxAgeSec,
        user: { id: dbUser.id, role: dbUser.role },
        rememberMe,
      };
    })
    .catch((err) => {
      if (err instanceof AppError) throw err;

      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'unknown';

      throw new AppError(`refresh: unexpected error (${msg})`, 500);
    });
}

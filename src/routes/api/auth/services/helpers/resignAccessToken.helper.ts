import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';
import { AppError, BadRequestError, UnauthorizedError, InternalError } from '@utils/errors.js';
import { verifyRefreshToken } from '@utils/jwt.js';

import { setUserContext } from '@db/dbContext.service.js';

import {
  getRefreshTokenRow,
  assertRefreshRowBasicsOrThrow,
  assertNotReusedAndHashOkOrThrow,
  assertNotExpiredInDbOrThrow,
  rotateFixedDeadlineTokens,
} from './tokenRotation.helper.js';

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
  if (!rt) throw new BadRequestError('REFRESH_TOKEN_REQUIRED');

  // decode refresh token payload
  const { userId, role: tokenRole, jwtId, rememberMe } = verifyRefreshToken(rt);

  if (!Number.isInteger(userId) || userId <= 0)
    throw new UnauthorizedError('REFRESH_PAYLOAD_USER_ID_INVALID');
  if (!Number.isInteger(jwtId) || jwtId <= 0)
    throw new UnauthorizedError('REFRESH_PAYLOAD_JWT_ID_INVALID');
  if (tokenRole === 'GUEST') throw new UnauthorizedError('REFRESH_GUEST_TOKEN_FORBIDDEN');

  // open tx and set db context
  try {
    const outcome = await prisma.$transaction(
      async (tx): Promise<RefreshAccessResult | AppError> => {
        await setUserContext(tx, { userId, role: tokenRole });

        // load refresh token row
        const tokenRow = await getRefreshTokenRow(tx, jwtId);
        if (!tokenRow) throw new UnauthorizedError('REFRESH_TOKEN_ROW_NOT_FOUND');

        // basic token row checks
        assertRefreshRowBasicsOrThrow(tokenRow, { userId });

        const now = new Date();

        try {
          // block reuse and hash mismatch, closing every session of the user
          await assertNotReusedAndHashOkOrThrow(tx, {
            row: tokenRow,
            refreshToken: rt,
            now,
            userId,
            reuseMessage: 'REFRESH_TOKEN_REUSE_DETECTED',
            hashMismatchMessage: 'REFRESH_TOKEN_HASH_MISMATCH',
          });

          // block expired token in db, marking it used
          await assertNotExpiredInDbOrThrow(tx, {
            row: tokenRow,
            now,
            expiredMessage: 'REFRESH_TOKEN_EXPIRED',
          });
        } catch (err) {
          // these refusals have to keep what they wrote: thrown here, the error would roll back
          // the closed sessions and a copied token would go on working; returned, the transaction
          // commits and the error is thrown after it
          if (err instanceof AppError) return err;
          throw err;
        }

        // load user role from db
        const dbUser = await tx.user.findUnique({
          where: { id: userId },
          select: { id: true, role: true },
        });

        if (!dbUser) throw new UnauthorizedError('REFRESH_USER_NOT_FOUND');
        if (dbUser.role === 'GUEST') throw new UnauthorizedError('REFRESH_GUEST_USER_FORBIDDEN');

        // rotate tokens with fixed deadline
        const rotated = await rotateFixedDeadlineTokens(tx, {
          oldJwtId: tokenRow.id,
          sessionExpiresAt: tokenRow.expiresAt,
          now,
          user: { id: dbUser.id, role: dbUser.role },
          rememberMe,
          sessionId: tokenRow.sessionId,
          userAgent: tokenRow.userAgent,
        });

        return {
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken,
          refreshMaxAgeSec: rotated.refreshMaxAgeSec,
          user: { id: dbUser.id, role: dbUser.role },
          rememberMe,
        };
      },
    );

    if (outcome instanceof AppError) throw outcome;
    return outcome;
  } catch (err) {
    if (err instanceof AppError) throw err;

    throw new InternalError(undefined, err);
  }
}

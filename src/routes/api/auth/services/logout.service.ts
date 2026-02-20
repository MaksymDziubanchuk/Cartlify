import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';

import { AppError, isAppError } from '@utils/errors.js';
import { verifyRefreshToken } from '@utils/jwt.js';
import { verifyTokenHash } from '@helpers/tokenHash.js';

import type { LogoutDto } from 'types/dto/auth.dto.js';
import type { MessageResponseDto } from 'types/common.js';

import { setUserContext } from '@db/dbContext.service.js';

import {
  getRefreshTokenRow,
  markRefreshTokenUsed,
  revokeAllActiveRefreshTokens,
} from './helpers/tokenRotation.helper.js';

// logout by refresh token
// mark used or revoke all
export async function logout({
  refreshToken,
  allDevices = false,
}: LogoutDto): Promise<MessageResponseDto> {
  const rt = refreshToken?.trim();
  if (!rt) return { message: 'ok' };

  let payload: { userId: number; jwtId: number; role: Role };
  try {
    // decode refresh token payload
    const { userId, jwtId, role } = verifyRefreshToken(rt);
    payload = { userId, jwtId, role };
  } catch (err) {
    // ignore invalid refresh token
    if (isAppError(err)) return { message: 'ok' };
    throw new AppError('logout: unexpected verify error', 500);
  }

  const now = new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      // set db actor context
      await setUserContext(tx, { userId: payload.userId, role: payload.role });

      const tokenRow = await getRefreshTokenRow(tx, payload.jwtId);
      if (!tokenRow) return { message: 'ok' };

      // accept only matching refresh row
      if (tokenRow.userId !== payload.userId) return { message: 'ok' };
      if (tokenRow.type !== 'REFRESH_TOKEN') return { message: 'ok' };

      // block reused or mismatched token
      if (tokenRow.usedAt) return { message: 'ok' };

      const ok = verifyTokenHash(rt, tokenRow.token);
      if (!ok) return { message: 'ok' };

      // revoke token(s) in db
      if (allDevices) {
        await revokeAllActiveRefreshTokens(tx, { userId: payload.userId, at: now });
      } else {
        await markRefreshTokenUsed(tx, { jwtId: tokenRow.id, at: now });
      }

      return { message: 'ok' };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new AppError(`logout: unexpected`, 500);
  }
}

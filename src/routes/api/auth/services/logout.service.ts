import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';

import { InternalError, isAppError } from '@utils/errors.js';
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

// end every session of the signed-in user, whatever refresh token the browser holds
async function logoutEverywhere(userId: number, role: Role): Promise<MessageResponseDto> {
  try {
    return await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId, role });
      await revokeAllActiveRefreshTokens(tx, { userId, at: new Date() });

      return { message: 'ok' };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'LOGOUT_SERVICE_UNEXPECTED' }, err);
  }
}

// logout by refresh token
// mark used or revoke all
export async function logout({
  userId,
  role,
  refreshToken,
  allDevices = false,
}: LogoutDto): Promise<MessageResponseDto> {
  // every device: the sessions of the user end by the user id, no token is needed for that
  if (allDevices) return logoutEverywhere(userId, role);

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
    throw new InternalError({ reason: 'LOGOUT_VERIFY_UNEXPECTED' }, err);
  }

  // a refresh token of someone else is not this user's session: it is left alone,
  // the cookies of this browser are cleared all the same
  if (payload.userId !== userId) return { message: 'ok' };

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

      // end the session of this browser
      await markRefreshTokenUsed(tx, { jwtId: tokenRow.id, at: now });

      return { message: 'ok' };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'LOGOUT_SERVICE_UNEXPECTED' }, err);
  }
}

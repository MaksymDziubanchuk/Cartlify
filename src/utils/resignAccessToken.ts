import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';
import { AppError, BadRequestError, UnauthorizedError, ForbiddenError } from '@utils/errors.js';
import { signAccessToken, verifyRefreshToken, signRefreshToken } from '@utils/jwt.js';
import { verifyTokenHash, hashToken } from '@utils/tokenHash.js';
import { createPlaceholder } from './placeholder.js';

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

export async function refreshAccessTokenByRefreshToken({
  refreshToken,
}: RefreshAccessDto): Promise<RefreshAccessResult> {
  const rt = refreshToken?.trim();
  if (!rt) throw new BadRequestError('refresh: refreshToken required');

  const { userId, role: tokenRole, jwtId, rememberMe } = verifyRefreshToken(rt);

  if (!Number.isInteger(userId) || userId <= 0)
    throw new UnauthorizedError('refresh: bad payload userId');
  if (!Number.isInteger(jwtId) || jwtId <= 0)
    throw new UnauthorizedError('refresh: bad payload jwtId');
  if (tokenRole === 'GUEST') throw new UnauthorizedError('refresh: guest token forbidden');

  return prisma
    .$transaction(async (tx) => {
      await tx.$executeRaw`select cartlify.set_current_context(
        ${tokenRole}::cartlify."Role",
        ${userId}::int,
        NULL
      )`;

      const tokenRow = await tx.userToken.findUnique({
        where: { id: jwtId },
        select: { id: true, userId: true, type: true, token: true, expiresAt: true, usedAt: true },
      });

      if (!tokenRow) throw new UnauthorizedError('refresh: token row not found');
      if (tokenRow.userId !== userId) throw new UnauthorizedError('refresh: token user mismatch');
      if (tokenRow.type !== 'REFRESH_TOKEN')
        throw new UnauthorizedError('refresh: wrong token type');

      const now = new Date();

      // REUSE
      if (tokenRow.usedAt) {
        await tx.userToken.updateMany({
          where: { userId, type: 'REFRESH_TOKEN', usedAt: null },
          data: { usedAt: now },
        });
        throw new ForbiddenError('refresh: token reuse detected');
      }

      if (tokenRow.expiresAt.getTime() <= now.getTime()) {
        await tx.userToken.update({ where: { id: tokenRow.id }, data: { usedAt: now } });
        throw new UnauthorizedError('refresh: token expired (db)');
      }

      //  Hash mismatch
      const hashOk = verifyTokenHash(rt, tokenRow.token);
      if (!hashOk) {
        await tx.userToken.updateMany({
          where: { userId, type: 'REFRESH_TOKEN', usedAt: null },
          data: { usedAt: now },
        });
        throw new ForbiddenError('refresh: token hash mismatch');
      }

      const dbUser = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true },
      });

      if (!dbUser) throw new UnauthorizedError('refresh: user not found');
      if (dbUser.role === 'GUEST') throw new UnauthorizedError('refresh: guest forbidden');

      // --- ROTATION without extending session deadline ---
      const sessionExpiresAt = tokenRow.expiresAt;
      const refreshMaxAgeSec = Math.max(
        1,
        Math.floor((sessionExpiresAt.getTime() - now.getTime()) / 1000),
      );

      // mark old as used
      await tx.userToken.update({
        where: { id: tokenRow.id },
        data: { usedAt: now },
      });

      // create new token row with same expiresAt (fixed deadline)
      const placeholder = createPlaceholder(32, 'hex');

      const created = await tx.userToken.create({
        data: {
          userId: dbUser.id,
          type: 'REFRESH_TOKEN',
          token: placeholder,
          expiresAt: sessionExpiresAt,
        },
        select: { id: true },
      });

      const newJwtId = created.id;

      const newRefreshToken = signRefreshToken(
        { userId: dbUser.id, role: dbUser.role, type: 'refresh', jwtId: newJwtId, rememberMe },
        rememberMe,
      );

      const newRefreshHash = hashToken(newRefreshToken);

      await tx.userToken.update({
        where: { id: newJwtId },
        data: { token: newRefreshHash, expiresAt: sessionExpiresAt },
      });

      const accessToken = signAccessToken(
        { userId: dbUser.id, role: dbUser.role, type: 'access' },
        rememberMe,
      );

      return {
        accessToken,
        refreshToken: newRefreshToken,
        refreshMaxAgeSec,
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

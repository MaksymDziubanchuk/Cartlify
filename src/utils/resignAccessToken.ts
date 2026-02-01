import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';
import { AppError, BadRequestError, UnauthorizedError } from '@utils/errors.js';
import { signAccessToken, verifyRefreshToken } from '@utils/jwt.js';
import { verifyTokenHash } from '@utils/tokenHash.js';

export type RefreshAccessDto = {
  refreshToken: string;
};

export type RefreshAccessResult = {
  accessToken: string;
  user: { id: number; role: Role };
};

export async function refreshAccessTokenByRefreshToken({
  refreshToken,
}: RefreshAccessDto): Promise<RefreshAccessResult> {
  const rt = refreshToken?.trim();
  if (!rt) throw new BadRequestError('refresh: refreshToken required');

  const { userId, role: tokenRole, jwtId } = verifyRefreshToken(rt);

  if (!Number.isInteger(userId) || userId <= 0) {
    throw new UnauthorizedError('refresh: bad payload userId');
  }
  if (!Number.isInteger(jwtId) || jwtId <= 0) {
    throw new UnauthorizedError('refresh: bad payload jwtId');
  }
  if (tokenRole === 'GUEST') {
    throw new UnauthorizedError('refresh: guest token forbidden');
  }

  return prisma
    .$transaction(async (tx) => {
      await tx.$executeRaw`select cartlify.set_current_context(
        ${tokenRole}::cartlify."Role",
        ${userId}::int,
        NULL
      )`;

      const tokenRow = await tx.userToken.findUnique({
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

      if (!tokenRow) throw new UnauthorizedError('refresh: token row not found');
      if (tokenRow.userId !== userId) throw new UnauthorizedError('refresh: token user mismatch');
      if (tokenRow.type !== 'REFRESH_TOKEN')
        throw new UnauthorizedError('refresh: wrong token type');

      if (tokenRow.usedAt) throw new UnauthorizedError('refresh: token already used');

      const now = new Date();

      if (tokenRow.expiresAt.getTime() <= now.getTime()) {
        if (!tokenRow.usedAt) {
          await tx.userToken.update({
            where: { id: tokenRow.id },
            data: { usedAt: now },
          });
        }

        throw new UnauthorizedError('refresh: token expired (db)');
      }

      const ok = verifyTokenHash(rt, tokenRow.token);
      if (!ok) throw new UnauthorizedError('refresh: token hash mismatch');

      const dbUser = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true },
      });

      if (!dbUser) throw new UnauthorizedError('refresh: user not found');
      if (dbUser.role === 'GUEST') throw new UnauthorizedError('refresh: guest forbidden');

      const rememberMe = true;
      const accessToken = signAccessToken(
        { userId: dbUser.id, role: dbUser.role, type: 'access' },
        rememberMe,
      );

      return { accessToken, user: { id: dbUser.id, role: dbUser.role } };
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

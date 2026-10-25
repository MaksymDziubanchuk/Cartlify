import type { Role } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { verifyTokenHash } from '@helpers/tokenHash.js';
import { InternalError, isAppError, NotFoundError } from '@utils/errors.js';
import { verifyRefreshToken } from '@utils/jwt.js';

import type { Tx } from './helpers/tokenRotation.helper.js';

import type { SessionItemDto, SessionsResponseDto } from 'types/dto/auth.dto.js';

type SessionsActorDto = { userId: number; role: Role; refreshToken?: string };

// the session of the refresh cookie of this browser, null without one of this user
export async function currentSessionIdOf(
  tx: Tx,
  userId: number,
  refreshToken: string | undefined,
): Promise<string | null> {
  const rt = refreshToken?.trim();
  if (!rt) return null;

  let jwtId: number;
  try {
    const payload = verifyRefreshToken(rt);
    if (payload.userId !== userId) return null;
    jwtId = payload.jwtId;
  } catch {
    return null;
  }

  const row = await tx.userToken.findUnique({
    where: { id: jwtId },
    select: { userId: true, type: true, token: true, sessionId: true },
  });
  if (!row || row.userId !== userId || row.type !== 'REFRESH_TOKEN') return null;

  return verifyTokenHash(rt, row.token) ? row.sessionId : null;
}

// the open sessions of the user, the newest renewal first: the browser that opened each, when it
// was renewed last, its deadline, and which is this one. A session opened before sessions had ids
// shows once it renews
export async function listSessions({
  userId,
  role,
  refreshToken,
}: SessionsActorDto): Promise<SessionsResponseDto> {
  try {
    return await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId, role });

      const current = await currentSessionIdOf(tx, userId, refreshToken);
      const rows = await tx.userToken.findMany({
        where: {
          userId,
          type: 'REFRESH_TOKEN',
          usedAt: null,
          expiresAt: { gt: new Date() },
          sessionId: { not: null },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { sessionId: true, userAgent: true, createdAt: true, expiresAt: true },
      });

      // a session has one open token; two renewals at the same moment may leave two
      const seen = new Set<string>();
      const items: SessionItemDto[] = [];
      for (const row of rows) {
        if (seen.has(row.sessionId!)) continue;
        seen.add(row.sessionId!);

        items.push({
          id: row.sessionId!,
          device: row.userAgent,
          lastUsedAt: row.createdAt,
          expiresAt: row.expiresAt,
          current: row.sessionId === current,
        });
      }

      return { items };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'SESSIONS_LIST_UNEXPECTED' }, err);
  }
}

// ends one session of the user on purpose; true when it was the session of this browser, its
// cookies are cleared then. A session of another user or one that ended: 404 SESSION_NOT_FOUND
export async function closeSession({
  userId,
  role,
  refreshToken,
  sessionId,
}: SessionsActorDto & { sessionId: string }): Promise<{ current: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId, role });

      const current = await currentSessionIdOf(tx, userId, refreshToken);
      const now = new Date();

      const closed = await tx.userToken.updateMany({
        where: { userId, type: 'REFRESH_TOKEN', sessionId, usedAt: null },
        data: { usedAt: now, revokedAt: now },
      });
      if (closed.count === 0) throw new NotFoundError('SESSION_NOT_FOUND');

      return { current: sessionId === current };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'SESSION_CLOSE_UNEXPECTED' }, err);
  }
}

import type { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

import env from '@config/env.js';
import { verifyAccessToken, getTtl } from '@utils/jwt.js';
import { AppError, BadRequestError, UnauthorizedError } from '@utils/errors.js';
import { isErrorNamed } from '@utils/errors.js';
import {
  setAccessTokenCookie,
  setRefreshTokenCookie,
  setGuestIdCookie,
  clearAccessTokenCookie,
  clearRefreshTokenCookie,
  shouldClearRefreshCookieOnRefreshError,
} from '@routes/api/auth//services/helpers/authCookies.js';

import { refreshAccessTokenByRefreshToken } from '@routes/api/auth/services/helpers/resignAccessToken.service.js';

const GUEST_ID_TTL = Number(env.GUEST_ID_TTL);

type SilentRefreshResult = { ok: true } | { ok: false; reason: 'invalid' | 'transient' };

async function trySilentRefresh(
  req: FastifyRequest,
  reply: FastifyReply,
  refreshToken: string,
): Promise<SilentRefreshResult> {
  try {
    const {
      accessToken,
      refreshToken: newRefreshToken,
      user,
      rememberMe,
      refreshMaxAgeSec,
    } = await refreshAccessTokenByRefreshToken({ refreshToken });

    const accessTtl = getTtl(rememberMe, 'access');

    setAccessTokenCookie(reply, accessToken, accessTtl as number);
    setRefreshTokenCookie(reply, newRefreshToken, refreshMaxAgeSec);

    req.user = { id: user.id, role: user.role };
    return { ok: true };
  } catch (err) {
    if (shouldClearRefreshCookieOnRefreshError(err)) {
      clearRefreshTokenCookie(reply);
      clearAccessTokenCookie(reply);
      return { ok: false, reason: 'invalid' };
    }

    req.log.info('silent refresh failed');
    return { ok: false, reason: 'transient' };
  }
}

async function ensureGuest(req: FastifyRequest, reply: FastifyReply) {
  const cookies = (req.cookies as Record<string, string | undefined>) ?? {};
  let guestId = cookies?.guestId;

  if (!guestId) {
    guestId = randomUUID();

    setGuestIdCookie(reply, guestId, GUEST_ID_TTL);
  }

  req.user = { id: guestId, role: 'GUEST' };
}

export default async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  if (!req.url.startsWith('/api/')) return;
  const cookies = (req.cookies as Record<string, string | undefined>) ?? {};

  const accessToken = cookies?.accessToken;
  const refreshToken = cookies?.refreshToken;

  if (accessToken) {
    try {
      const { userId, role, type } = verifyAccessToken(accessToken);
      if (type !== 'access') throw new Error('bad access type');

      req.user = { id: userId, role };
      return;
    } catch (err) {
      clearAccessTokenCookie(reply);

      if (refreshToken) {
        const res = await trySilentRefresh(req, reply, refreshToken);
        if (res.ok) return;
      }

      if (isErrorNamed(err, 'TokenExpiredError')) {
        req.log.info('need login (access expired, refresh missing/failed)');
      } else {
        req.log.info('need login (access invalid, refresh missing/failed)');
      }

      throw new BadRequestError('LOGIN_REQUIRED');
    }
  }

  if (refreshToken) {
    const res = await trySilentRefresh(req, reply, refreshToken);

    if (res.ok) return;

    if (res.reason === 'invalid') {
      req.log.info('need login (refresh invalid/expired)');
      throw new UnauthorizedError('LOGIN_REQUIRED');
    }

    req.log.info('need login (no access, refresh invalid/expired)');
    throw new AppError('AUTH_TEMPORARILY_UNAVAILABLE', 503);
  }

  await ensureGuest(req, reply);
}

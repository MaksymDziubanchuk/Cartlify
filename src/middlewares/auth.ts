import type { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

import env from '@config/env.js';
import { verifyAccessToken, getTtl } from '@utils/jwt.js';
import { AppError, UnauthorizedError } from '@utils/errors.js';
import {
  setAccessTokenCookie,
  setRefreshTokenCookie,
  setGuestIdCookie,
  clearAccessTokenCookie,
  clearRefreshTokenCookie,
  shouldClearRefreshCookieOnRefreshError,
} from '@routes/api/auth/services/helpers/authCookies.helper.js';

import { refreshAccessTokenByRefreshToken } from '@routes/api/auth/services/helpers/resignAccessToken.helper.js';

const GUEST_ID_TTL = Number(env.GUEST_ID_TTL);

type SilentRefreshResult = { ok: true } | { ok: false; reason: 'invalid' };

// refresh access token silently
async function trySilentRefresh(
  req: FastifyRequest,
  reply: FastifyReply,
  refreshToken: string,
): Promise<SilentRefreshResult> {
  try {
    // rotate tokens by refresh
    const {
      accessToken,
      refreshToken: newRefreshToken,
      user,
      rememberMe,
      refreshMaxAgeSec,
    } = await refreshAccessTokenByRefreshToken({ refreshToken });

    const accessTtl = getTtl(rememberMe, 'access');

    // set new auth cookies
    setAccessTokenCookie(reply, accessToken, accessTtl as number);
    setRefreshTokenCookie(reply, newRefreshToken, refreshMaxAgeSec);

    // attach user to request
    req.user = { id: user.id, role: user.role };
    return { ok: true };
  } catch (err) {
    // clear cookies on invalid refresh
    if (shouldClearRefreshCookieOnRefreshError(err)) {
      clearRefreshTokenCookie(reply);
      clearAccessTokenCookie(reply);
      return { ok: false, reason: 'invalid' };
    }

    throw new AppError({
      statusCode: 503,
      errorCode: 'AUTH_TEMPORARILY_UNAVAILABLE',
      message: 'Service Unavailable',
    });
  }
}

async function ensureGuest(req: FastifyRequest, reply: FastifyReply) {
  const cookies = (req.cookies as Record<string, string | undefined>) ?? {};
  let guestId = cookies?.guestId;

  // issue guest id cookie
  if (!guestId) {
    guestId = randomUUID();

    setGuestIdCookie(reply, guestId, GUEST_ID_TTL);
  }

  // attach guest to request
  req.user = { id: guestId, role: 'GUEST' };
}

export default async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  if (!req.url.startsWith('/api/')) return;
  const cookies = (req.cookies as Record<string, string | undefined>) ?? {};

  // read auth cookies
  const accessToken = cookies?.accessToken;
  const refreshToken = cookies?.refreshToken;

  if (accessToken) {
    try {
      // verify access token payload
      const { userId, role, type } = verifyAccessToken(accessToken);
      if (type !== 'access') throw new UnauthorizedError('LOGIN_REQUIRED');

      // attach user to request
      req.user = { id: userId, role };
      return;
    } catch (err) {
      // drop invalid access cookie
      clearAccessTokenCookie(reply);

      if (refreshToken) {
        // fallback to silent refresh
        const res = await trySilentRefresh(req, reply, refreshToken);
        if (res.ok) return;
      }

      throw new UnauthorizedError('LOGIN_REQUIRED');
    }
  }

  if (refreshToken) {
    // try refresh without access cookie
    const res = await trySilentRefresh(req, reply, refreshToken);

    if (res.ok) return;

    throw new UnauthorizedError('LOGIN_REQUIRED');
  }

  // fallback to guest context
  await ensureGuest(req, reply);
}

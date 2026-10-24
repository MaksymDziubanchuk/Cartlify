import type { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

import env from '@config/env.js';
import { verifyAccessToken, getTtl } from '@utils/jwt.js';
import { AccessTokenExpiredError, AppError, UnauthorizedError } from '@utils/errors.js';
import { isUuid } from '@db/dbContext.service.js';
import {
  setAccessTokenCookie,
  setRefreshTokenCookie,
  setGuestIdCookie,
  clearAccessTokenCookie,
  clearRefreshTokenCookie,
  shouldClearRefreshCookieOnRefreshError,
} from '@routes/api/auth/services/helpers/authCookies.helper.js';

import { refreshAccessTokenByRefreshToken } from '@routes/api/auth/services/helpers/resignAccessToken.helper.js';

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
    req.issuedRefreshToken = newRefreshToken;
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

  // issue guest id cookie when there is none or it is not a uuid,
  // guest ids are uuid columns in the db and a broken one would fail every guest request
  if (!isUuid(guestId)) {
    guestId = randomUUID();

    setGuestIdCookie(reply, guestId, env.GUEST_ID_TTL);
  }

  // attach guest to request
  req.user = { id: guestId, role: 'GUEST' };
}

// puts the user of a valid access token on the request; false when the token is not one
function userOfAccessToken(req: FastifyRequest, accessToken: string): boolean {
  try {
    const { userId, role, type, exp } = verifyAccessToken(accessToken);
    if (type !== 'access') return false;

    req.user = { id: userId, role };
    req.accessTokenExpiresAt = exp * 1000;
    return true;
  } catch {
    return false;
  }
}

// hangs only on api routes; it does not look at req.url: the router matches /%61pi/... and the
// absolute form to the same routes, and a request left without a user failed with 500
export default async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  const cookies = (req.cookies as Record<string, string | undefined>) ?? {};

  // read auth cookies
  const accessToken = cookies?.accessToken;
  const refreshToken = cookies?.refreshToken;

  if (accessToken) {
    try {
      if (!userOfAccessToken(req, accessToken)) throw new UnauthorizedError('LOGIN_REQUIRED');
      return;
    } catch {
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

// the guard of the chat socket: the answer of a handshake becomes the socket, the cookies of a
// session renewed here would never reach the browser, and its next request would bring the spent
// refresh token and close every session of the user. Without a valid access token a signed-in
// user gets 401 ACCESS_TOKEN_EXPIRED, renews the session with POST /api/auth/refresh and connects
// again; without any session cookie the visitor is a guest
export async function authGuardWithoutRefresh(req: FastifyRequest, reply: FastifyReply) {
  const cookies = (req.cookies as Record<string, string | undefined>) ?? {};

  if (cookies.accessToken && userOfAccessToken(req, cookies.accessToken)) return;

  if (cookies.accessToken || cookies.refreshToken) throw new AccessTokenExpiredError();

  await ensureGuest(req, reply);
}

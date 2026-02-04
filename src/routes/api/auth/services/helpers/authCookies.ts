import type { FastifyReply } from 'fastify';
import env from '@config/env.js';
import { isAppError, isErrorNamed } from '@utils/errors.js';

const isProd = env.NODE_ENV === 'production';

type CookieBaseOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
};

export function markAuthCookiesNoStore(reply: FastifyReply) {
  // disable caching for auth
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.header('Expires', '0');
}

function base(): CookieBaseOptions {
  // shared cookie security flags
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  };
}

// GUEST ID

export function setGuestIdCookie(reply: FastifyReply, guestId: string, maxAgeSec: number) {
  markAuthCookiesNoStore(reply);
  reply.setCookie('guestId', guestId, { ...base(), maxAge: maxAgeSec });
}

export function clearGuestIdCookie(reply: FastifyReply) {
  markAuthCookiesNoStore(reply);
  reply.clearCookie('guestId', base());
}

// ACCESS TOKEN

export function setAccessTokenCookie(reply: FastifyReply, accessToken: string, maxAgeSec: number) {
  markAuthCookiesNoStore(reply);
  reply.setCookie('accessToken', accessToken, { ...base(), maxAge: maxAgeSec });
}

export function clearAccessTokenCookie(reply: FastifyReply) {
  markAuthCookiesNoStore(reply);
  reply.clearCookie('accessToken', base());
}

// REFRESH TOKEN

export function setRefreshTokenCookie(
  reply: FastifyReply,
  refreshToken: string,
  maxAgeSec: number,
) {
  markAuthCookiesNoStore(reply);
  reply.setCookie('refreshToken', refreshToken, { ...base(), maxAge: maxAgeSec });
}

export function clearRefreshTokenCookie(reply: FastifyReply) {
  markAuthCookiesNoStore(reply);
  reply.clearCookie('refreshToken', base());
}

export function clearAuthCookies(reply: FastifyReply) {
  clearAccessTokenCookie(reply);
  clearRefreshTokenCookie(reply);
}

export function shouldClearRefreshCookieOnRefreshError(err: unknown): boolean {
  if (isErrorNamed(err, 'TokenExpiredError')) return true;
  if (isErrorNamed(err, 'JsonWebTokenError')) return true;
  if (isErrorNamed(err, 'NotBeforeError')) return true;

  // handle app refresh errors
  if (isAppError(err)) {
    const status = (err as any).statusCode ?? (err as any).status;
    const msg = String((err as any).message ?? '');

    // detect refresh invalid errors
    const isAuthStatus = status === 400 || status === 401 || status === 403;
    const looksLikeRefreshInvalid = msg.startsWith('refresh:') || msg.includes('REFRESH');

    // clear cookie on match
    if (isAuthStatus && looksLikeRefreshInvalid) return true;
  }

  return false;
}

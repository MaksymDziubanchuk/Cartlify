import type { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

import env from '@config/env.js';
import { verifyAccessToken, getTtl } from '@utils/jwt.js';
import { BadRequestError } from '@utils/errors.js';
import { isErrorNamed } from '@utils/errors.js';

import { refreshAccessTokenByRefreshToken } from '@utils/resignAccessToken.js';

const isProd = env.NODE_ENV === 'production';

const baseCookie = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax' as const,
} as const;

const GUEST_ID_TTL = Number(env.GUEST_ID_TTL);

async function trySilentRefresh(
  req: FastifyRequest,
  reply: FastifyReply,
  refreshToken: string,
): Promise<boolean> {
  try {
    const { accessToken, user, rememberMe } = await refreshAccessTokenByRefreshToken({
      refreshToken,
    });

    const accessTtl = getTtl(rememberMe, 'access');

    reply.clearCookie('accessToken', {
      ...baseCookie,
      path: '/',
    });

    reply.setCookie('accessToken', accessToken, {
      ...baseCookie,
      path: '/',
      maxAge: accessTtl as number,
    });

    req.user = { id: user.id, role: user.role };
    return true;
  } catch (err) {
    req.log.info('silent refresh failed');
    return false;
  }
}

async function ensureGuest(req: FastifyRequest, reply: FastifyReply) {
  const cookies = (req.cookies as Record<string, string | undefined>) ?? {};
  let guestId = cookies?.guestId;

  if (!guestId) {
    guestId = randomUUID();

    reply.clearCookie('guestId', {
      ...baseCookie,
      path: '/',
    });

    reply.setCookie('guestId', guestId, {
      ...baseCookie,
      path: '/',
      maxAge: GUEST_ID_TTL,
    });
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
      if (refreshToken) {
        const ok = await trySilentRefresh(req, reply, refreshToken);
        if (ok) return;
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
    const ok = await trySilentRefresh(req, reply, refreshToken);

    if (ok) return;

    req.log.info('need login (no access, refresh invalid/expired)');
    throw new BadRequestError('LOGIN_REQUIRED');
  }

  await ensureGuest(req, reply);
}

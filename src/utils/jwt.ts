import jwt from 'jsonwebtoken';
import type { Secret, SignOptions } from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import env from '@config/env.js';
import { AppError, AccessTokenExpiredError, isErrorNamed } from '@utils/errors.js';

export type AccessTokenPayload = {
  userId: number;
  role: Role;
  type: string;
};

export type VerifiedAccessToken = AccessTokenPayload & { exp: number };

export type RefreshTokenPayload = {
  userId: number;
  role: Role;
  type: string;
  jwtId: number;
  rememberMe: boolean;
};

export type VerifiedRefreshToken = RefreshTokenPayload & { exp: number };

export type ExpiresIn = Exclude<SignOptions['expiresIn'], undefined>;

type TokenType = 'access' | 'refresh';

// pick ttl from env by type
export function getTtl(rememberMe: boolean, type: TokenType): ExpiresIn | number {
  const envKey =
    type === 'access'
      ? rememberMe
        ? 'JWT_ACCESS_TTL_LONG'
        : 'JWT_ACCESS_TTL_SHORT'
      : rememberMe
        ? 'JWT_REFRESH_TTL_LONG'
        : 'JWT_REFRESH_TTL_SHORT';

  // read ttl string from env
  const raw = (env as Record<string, unknown>)[envKey];

  if (typeof raw !== 'string') {
    throw new AppError(`Server misconfigured: ${envKey} is missing`, 500);
  }

  const compact = raw.trim();

  if (!compact) {
    throw new AppError(`Server misconfigured: ${envKey} is empty`, 500);
  }

  // validate ttl format and range
  if (!/^\d+$/.test(compact)) {
    throw new AppError(
      `Server misconfigured: ${envKey} (seconds integer expected, e.g. "3600")`,
      500,
    );
  }

  const seconds = Number(compact);

  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new AppError(
      `Server misconfigured: ${envKey} (must be a positive safe integer seconds)`,
      500,
    );
  }

  return seconds;
}

export function signAccessToken(payload: AccessTokenPayload, rememberMe: boolean): string {
  // validate ttl format and range
  const secret = env.JWT_ACCESS_SECRET as Secret;

  const options: SignOptions = {
    expiresIn: getTtl(rememberMe, 'access') as ExpiresIn,
  };

  return jwt.sign(payload, secret, options);
}

export function signRefreshToken(payload: RefreshTokenPayload, rememberMe: boolean): string {
  // sign refresh token with ttl
  const secret = env.JWT_REFRESH_SECRET as Secret;

  const options: SignOptions = {
    expiresIn: getTtl(rememberMe, 'refresh') as ExpiresIn,
  };

  return jwt.sign(payload, secret, options);
}

export function verifyAccessToken(token: string): VerifiedAccessToken {
  // verify access token signature
  const secret = env.JWT_ACCESS_SECRET as Secret;

  let decoded: unknown;
  try {
    decoded = jwt.verify(token, secret);

    if (typeof decoded !== 'object' || decoded === null) {
      throw new AppError('Invalid access token payload', 401);
    }

    // verify access token signature
    const { userId, role, type, exp } = decoded as Partial<AccessTokenPayload & { exp: number }>;

    if (typeof userId !== 'number' || !role || type !== 'access' || typeof exp !== 'number') {
      throw new AppError('Invalid access token payload', 401);
    }

    return { userId, role: role as Role, type, exp };
  } catch (err) {
    if (isErrorNamed(err, 'TokenExpiredError')) {
      throw new AccessTokenExpiredError();
    }

    throw new AppError('Invalid access token', 401);
  }
}

export function verifyRefreshToken(token: string): VerifiedRefreshToken {
  // verify refresh token signature
  const secret = env.JWT_REFRESH_SECRET as Secret;

  let decoded: unknown;
  try {
    decoded = jwt.verify(token, secret);
  } catch (e) {
    throw new AppError('Invalid refresh token', 401);
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw new AppError('Invalid refresh token payload', 401);
  }

  // validate refresh token payload
  const { userId, role, type, jwtId, exp, rememberMe } = decoded as Partial<
    RefreshTokenPayload & { exp: number }
  >;

  if (
    typeof userId !== 'number' ||
    !role ||
    type !== 'refresh' ||
    typeof jwtId !== 'number' ||
    typeof exp !== 'number' ||
    typeof rememberMe !== 'boolean'
  ) {
    throw new AppError('Invalid refresh token payload', 401);
  }

  return { userId, role: role as Role, type, jwtId, exp, rememberMe };
}

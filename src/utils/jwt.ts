import jwt from 'jsonwebtoken';
import type { Secret, SignOptions } from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import env from '@config/env.js';
import { AppError, BadRequestError, AccessTokenExpiredError } from '@utils/errors.js';

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
};

export type VerifiedRefreshToken = RefreshTokenPayload & { exp: number };

export type ExpiresIn = Exclude<SignOptions['expiresIn'], undefined>;

export function getTtl(rememberMe: boolean, type: string): ExpiresIn {
  let raw = '';

  if (type === 'access') {
    raw = rememberMe ? env.JWT_ACCESS_TTL_LONG : env.JWT_ACCESS_TTL_SHORT;
  } else if (type === 'refresh') {
    raw = rememberMe ? env.JWT_ACCESS_TTL_LONG : env.JWT_ACCESS_TTL_SHORT;
  } else
    throw new BadRequestError(
      `Invalid JWT access TTL: "${raw}" (expected e.g. "3600", "1h", "30d")`,
    );

  const compact = raw.trim().toLowerCase().replace(/\s+/g, '');

  if (/^\d+$/.test(compact)) return Number(compact);

  const m = compact.match(/^(\d+)([smhd])$/);
  if (m) return `${m[1]}${m[2]}` as ExpiresIn;

  throw new BadRequestError(`Invalid JWT access TTL: "${raw}" (expected e.g. "3600", "1h", "30d")`);
}

export function signAccessToken(payload: AccessTokenPayload, rememberMe: boolean): string {
  const secret = env.JWT_ACCESS_SECRET as Secret;

  const options: SignOptions = {
    expiresIn: getTtl(rememberMe, 'access'),
  };

  return jwt.sign(payload, secret, options);
}

export function signRefreshToken(payload: RefreshTokenPayload, rememberMe: boolean): string {
  const secret = env.JWT_REFRESH_SECRET as Secret;

  const options: SignOptions = {
    expiresIn: getTtl(rememberMe, 'refresh'),
  };

  return jwt.sign(payload, secret, options);
}

export function verifyAccessToken(token: string): VerifiedAccessToken {
  const secret = env.JWT_ACCESS_SECRET as Secret;

  let decoded: unknown;
  try {
    decoded = jwt.verify(token, secret);

    if (typeof decoded !== 'object' || decoded === null) {
      throw new AppError('Invalid access token payload', 401);
    }

    const { userId, role, type, exp } = decoded as Partial<
      AccessTokenPayload & { exp: number; iat: number }
    >;

    if (typeof userId !== 'number' || !role || type !== 'refresh' || typeof exp !== 'number') {
      throw new AppError('Invalid refresh token payload', 401);
    }

    return { userId, role: role as Role, type, exp };
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'TokenExpiredError'
    ) {
      throw new AccessTokenExpiredError();
    }

    throw new AppError('Invalid access token', 401);
  }
}

export function verifyRefreshToken(token: string): VerifiedRefreshToken {
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

  const { userId, role, type, jwtId, exp } = decoded as Partial<
    RefreshTokenPayload & { exp: number }
  >;

  if (
    typeof userId !== 'number' ||
    !role ||
    type !== 'refresh' ||
    typeof jwtId !== 'number' ||
    typeof exp !== 'number'
  ) {
    throw new AppError('Invalid refresh token payload', 401);
  }

  return { userId, role: role as Role, type, jwtId, exp };
}

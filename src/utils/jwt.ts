import jwt from 'jsonwebtoken';
import type { Secret, SignOptions } from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import env from '@config/env.js';
import { AccessTokenExpiredError, UnauthorizedError, isErrorNamed } from '@utils/errors.js';

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

// the lifetime of a token in seconds; env.ts checks all four at the start
export function getTtl(rememberMe: boolean, type: TokenType): number {
  if (type === 'access') return rememberMe ? env.JWT_ACCESS_TTL_LONG : env.JWT_ACCESS_TTL_SHORT;

  return rememberMe ? env.JWT_REFRESH_TTL_LONG : env.JWT_REFRESH_TTL_SHORT;
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
  } catch (err) {
    if (isErrorNamed(err, 'TokenExpiredError')) {
      throw new AccessTokenExpiredError();
    }

    throw new UnauthorizedError('ACCESS_TOKEN_INVALID');
  }

  // payload checks stay outside the try, so their own code is not replaced by ACCESS_TOKEN_INVALID
  if (typeof decoded !== 'object' || decoded === null) {
    throw new UnauthorizedError('ACCESS_TOKEN_PAYLOAD_INVALID');
  }

  // validate access token payload
  const { userId, role, type, exp } = decoded as Partial<AccessTokenPayload & { exp: number }>;

  if (typeof userId !== 'number' || !role || type !== 'access' || typeof exp !== 'number') {
    throw new UnauthorizedError('ACCESS_TOKEN_PAYLOAD_INVALID');
  }

  return { userId, role: role as Role, type, exp };
}

export function verifyRefreshToken(token: string): VerifiedRefreshToken {
  // verify refresh token signature
  const secret = env.JWT_REFRESH_SECRET as Secret;

  let decoded: unknown;
  try {
    decoded = jwt.verify(token, secret);
  } catch {
    throw new UnauthorizedError('REFRESH_TOKEN_INVALID');
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw new UnauthorizedError('REFRESH_TOKEN_PAYLOAD_INVALID');
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
    throw new UnauthorizedError('REFRESH_TOKEN_PAYLOAD_INVALID');
  }

  return { userId, role: role as Role, type, jwtId, exp, rememberMe };
}

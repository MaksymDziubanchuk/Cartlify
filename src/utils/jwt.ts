import jwt from 'jsonwebtoken';
import type { Secret, SignOptions } from 'jsonwebtoken';
import type { Role } from '@prisma/client';

type AccessTokenPayload = {
  userId: number;
  role: Role;
};

type ExpiresIn = Exclude<SignOptions['expiresIn'], undefined>;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function getAccessTtl(rememberMe: boolean): ExpiresIn {
  const raw = rememberMe ? requireEnv('JWT_ACCESS_TTL_LONG') : requireEnv('JWT_ACCESS_TTL_SHORT');

  const s = raw.trim();

  if (/^\d+$/.test(s)) return Number(s);

  return s as ExpiresIn;
}

export function signAccessToken(payload: AccessTokenPayload, rememberMe: boolean): string {
  const secret = requireEnv('JWT_ACCESS_SECRET') as Secret;

  const options: SignOptions = {
    expiresIn: getAccessTtl(rememberMe),
  };

  return jwt.sign(payload, secret, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const secret = requireEnv('JWT_ACCESS_SECRET') as Secret;
  const decoded = jwt.verify(token, secret);

  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('Invalid token payload');
  }

  const { userId, role } = decoded as Partial<AccessTokenPayload>;

  if (typeof userId !== 'number' || !role) {
    throw new Error('Invalid token payload');
  }

  return { userId, role: role as Role };
}

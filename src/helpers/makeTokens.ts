import { randomBytes } from 'node:crypto';

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// build email verify token
export function makeVerifyToken(): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

  return { token, expiresAt };
}
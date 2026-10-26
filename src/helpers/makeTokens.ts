import { randomBytes } from 'node:crypto';

import env from '@config/env.js';

// build email verify token; it lives VERIFY_TTL_MS, a day unless set
export function makeVerifyToken(): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.VERIFY_TTL_MS);

  return { token, expiresAt };
}
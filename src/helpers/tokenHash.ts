import crypto from 'node:crypto';
import { BadRequestError, InternalError } from '@utils/errors.js';

export type HashEncoding = 'hex' | 'base64url';

// hash token for db storage
export function hashToken(token: string, encoding: HashEncoding = 'hex'): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new BadRequestError('TOKEN_INVALID');
  }

  return crypto.createHash('sha256').update(token).digest(encoding);
}

// compare token to stored hash
export function verifyTokenHash(
  token: string,
  expectedHash: string,
  encoding: HashEncoding = 'hex',
): boolean {
  if (typeof expectedHash !== 'string' || expectedHash.length === 0) {
    throw new InternalError({ reason: 'EXPECTED_TOKEN_HASH_INVALID' });
  }

  if (typeof token !== 'string' || token.length === 0) return false;

  // compute actual token hash
  const actualHash = hashToken(token, encoding);

  const a = Buffer.from(actualHash);
  const b = Buffer.from(expectedHash);

  // timing-safe hash compare
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

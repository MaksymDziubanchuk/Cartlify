import crypto from 'node:crypto';
import { AppError } from '@utils/errors.js';

export type HashEncoding = 'hex' | 'base64url';

// hash token for db storage
export function hashToken(token: string, encoding: HashEncoding = 'hex'): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new AppError('Token for hashing must be a non-empty string', 500);
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
    throw new AppError('Expected token hash must be a non-empty string', 500);
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

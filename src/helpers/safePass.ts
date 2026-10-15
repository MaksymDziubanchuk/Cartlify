import bcrypt from 'bcrypt';
import env from '@config/env.js';
import { BadRequestError, InternalError } from '@utils/errors.js';

// parse bcrypt cost from env
const roundsRaw = (env as Record<string, unknown>).BCRYPT_ROUNDS;
const rounds =
  typeof roundsRaw === 'string'
    ? Number(roundsRaw)
    : typeof roundsRaw === 'number'
      ? roundsRaw
      : 12;
// validate bcrypt cost bounds
if (!Number.isInteger(rounds) || rounds < 10 || rounds > 15) {
  throw new InternalError({ key: 'BCRYPT_ROUNDS' });
}

// bcrypt reads only the first 72 bytes and silently drops the rest
const BCRYPT_MAX_BYTES = 72;

// hash password with configured cost
export async function hashPass(password: string): Promise<string> {
  // the route schemas already allow at most 64 ascii characters, this guards every other way in
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) {
    throw new BadRequestError('PASSWORD_TOO_LONG');
  }

  const passwordHash = await bcrypt.hash(password, rounds);
  return passwordHash;
}

// compare plain password to hash
export async function verifyPass(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

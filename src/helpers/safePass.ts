import bcrypt from 'bcrypt';
import env from '@config/env.js';
import { AppError } from '@utils/errors.js';

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
  throw new AppError('Server misconfigured: BCRYPT_ROUNDS', 500);
}

// hash password with configured cost
export async function hashPass(password: string): Promise<string> {
  const passwordHash = await bcrypt.hash(password, rounds);
  return passwordHash;
}

// compare plain password to hash
export async function verifyPass(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

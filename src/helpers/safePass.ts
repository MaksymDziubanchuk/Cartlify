import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 12;

export async function hashPass(password: string): Promise<string> {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  return passwordHash;
}

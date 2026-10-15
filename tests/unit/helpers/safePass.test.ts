import bcrypt from 'bcrypt';
import { describe, expect, it } from '@jest/globals';

import { hashPass, verifyPass } from '@helpers/safePass.js';

import { rejectedBy } from '../../helpers/errors.js';
import { importWithEnv } from '../../helpers/freshImport.js';

type SafePass = typeof import('@helpers/safePass.js');

describe('hashPass and verifyPass', () => {
  it('stores a bcrypt hash, never the password itself', async () => {
    const hash = await hashPass('correct horse battery staple');

    expect(hash).not.toContain('correct horse');
    // default cost from env is 12
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
  });

  it('gives a different hash each time, because bcrypt salts it', async () => {
    const [a, b] = await Promise.all([hashPass('same-password'), hashPass('same-password')]);

    expect(a).not.toBe(b);
  });

  it('accepts the right password and rejects a wrong one', async () => {
    const hash = await hashPass('S3cret!pass');

    await expect(verifyPass('S3cret!pass', hash)).resolves.toBe(true);
    await expect(verifyPass('S3cret!pas', hash)).resolves.toBe(false);
    await expect(verifyPass('s3cret!pass', hash)).resolves.toBe(false);
    await expect(verifyPass('', hash)).resolves.toBe(false);
  });

  it('hashes a password of exactly 72 bytes, all of which count', async () => {
    const password = 'x'.repeat(71) + 'a';
    const hash = await hashPass(password);

    await expect(verifyPass(password, hash)).resolves.toBe(true);
    await expect(verifyPass('x'.repeat(71) + 'b', hash)).resolves.toBe(false);
  });

  // bcrypt reads only the first 72 bytes, a longer password would be cut without a word
  it.each([
    ['73 ascii characters', 'x'.repeat(73)],
    // e with an acute accent takes two bytes
    ['37 two-byte letters', 'é'.repeat(37)],
  ])('refuses to hash a password over 72 bytes: %s', async (_case, password) => {
    const err = await rejectedBy(() => hashPass(password));

    expect(err).toMatchObject({ statusCode: 400, errorCode: 'PASSWORD_TOO_LONG' });
  });

  // a hash made before the limit; bcrypt compares the same first 72 bytes as when it was made
  it('still lets in a password that was set longer than 72 bytes before the limit', async () => {
    const oldPassword = 'y'.repeat(90);
    const oldHash = await bcrypt.hash(oldPassword, 4);

    await expect(verifyPass(oldPassword, oldHash)).resolves.toBe(true);
  });

  it('does not let in a new password with extra characters after it', async () => {
    const password = 'z'.repeat(64);
    const hash = await hashPass(password);

    await expect(verifyPass(password + 'extra-characters', hash)).resolves.toBe(false);
  });
});

describe('bcrypt cost from env', () => {
  const load = (rounds: string) =>
    importWithEnv<SafePass>('@helpers/safePass.js', { BCRYPT_ROUNDS: rounds });

  it('hashes with the configured cost', async () => {
    const { hashPass: hashWithCost } = await load('10');

    expect(await hashWithCost('S3cret!pass')).toMatch(/^\$2[aby]\$10\$/);
  });

  it.each([
    ['too cheap to resist guessing', '9'],
    ['so slow that a login hangs', '16'],
    ['not a whole number', '11.5'],
    ['not a number', 'twelve'],
  ])('refuses to start with a cost that is %s', async (_case, rounds) => {
    const err = await rejectedBy(() => load(rounds));

    expect(err).toMatchObject({ statusCode: 500, details: { key: 'BCRYPT_ROUNDS' } });
  });
});

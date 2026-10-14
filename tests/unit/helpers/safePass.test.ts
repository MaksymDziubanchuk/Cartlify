import { describe, expect, it } from '@jest/globals';

import { hashPass, verifyPass } from '@helpers/safePass.js';

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
});

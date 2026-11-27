import { describe, expect, it } from '@jest/globals';

import {
  decryptTwoFactorSecret,
  encryptTwoFactorSecret,
} from '@helpers/twoFactor/twoFactorKeys.js';

describe('the secret of an app in the database', () => {
  it('comes back as it went in, with the version of the key in front', () => {
    const text = encryptTwoFactorSecret('JBSWY3DPEHPK3PXP');

    expect(text).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(text).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptTwoFactorSecret(text)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('differs each time for the same secret', () => {
    expect(encryptTwoFactorSecret('ABC')).not.toBe(encryptTwoFactorSecret('ABC'));
  });

  it('is refused when a byte changed, or of another version or shape', () => {
    const [version, iv, tag, data] = encryptTwoFactorSecret('JBSWY3DPEHPK3PXP').split(':');
    const flipped = `${data!.slice(0, -2)}${data!.endsWith('AA') ? 'BB' : 'AA'}`;

    expect(() => decryptTwoFactorSecret([version, iv, tag, flipped].join(':'))).toThrow();
    expect(() => decryptTwoFactorSecret(['v2', iv, tag, data].join(':'))).toThrow(
      'TWO_FACTOR_SECRET_UNREADABLE',
    );
    expect(() => decryptTwoFactorSecret('v1:abc')).toThrow('TWO_FACTOR_SECRET_UNREADABLE');
  });
});

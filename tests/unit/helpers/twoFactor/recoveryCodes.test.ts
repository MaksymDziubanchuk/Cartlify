import { describe, expect, it } from '@jest/globals';

import { hashToken } from '@helpers/tokenHash.js';
import { newRecoveryCodes, recoveryCodeHash } from '@helpers/twoFactor/recoveryCodes.js';

describe('newRecoveryCodes', () => {
  it('gives ten different codes XXXXX-XXXXX without the signs a person mixes up', () => {
    const codes = newRecoveryCodes();

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    }
  });
});

describe('recoveryCodeHash', () => {
  it('is the sha256 of the code without the dash, the same for the case and spaces a person types', () => {
    expect(recoveryCodeHash('ABCDE-FGHJK')).toBe(hashToken('ABCDEFGHJK'));
    expect(recoveryCodeHash(' abcde fghjk ')).toBe(recoveryCodeHash('ABCDE-FGHJK'));
    expect(recoveryCodeHash('ABCDE-FGHJM')).not.toBe(recoveryCodeHash('ABCDE-FGHJK'));
  });
});

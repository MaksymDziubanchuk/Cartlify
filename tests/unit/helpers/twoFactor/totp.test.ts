import { describe, expect, it } from '@jest/globals';

import {
  base32Decode,
  base32Encode,
  matchTotpCode,
  newTotpSecret,
  otpauthUrl,
  totpCode,
  totpStepAt,
} from '@helpers/twoFactor/totp.js';

// the key of the SHA1 vectors of RFC 6238 (appendix B), "12345678901234567890", in base32
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('base32', () => {
  it('encodes the vectors of RFC 4648', () => {
    expect(base32Encode(Buffer.from(''))).toBe('');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('decodes what it encodes, ignoring case, spaces and padding', () => {
    expect(base32Decode('mzxw 6ytb oi==')?.toString()).toBe('foobar');
  });

  it('gives null for a letter outside the alphabet', () => {
    expect(base32Decode('MZXW1')).toBeNull();
  });
});

describe('totpCode', () => {
  // RFC 6238 gives eight digits; an app shows the last six
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the RFC 6238 vector at %i seconds', (seconds, eight) => {
    const step = totpStepAt(seconds * 1000);
    expect(totpCode(RFC_SECRET, step, 8)).toBe(eight);
    expect(totpCode(RFC_SECRET, step)).toBe(eight.slice(2));
  });

  it('refuses a secret that is not base32', () => {
    expect(() => totpCode('not base32!', 1)).toThrow('TOTP_SECRET_INVALID');
  });
});

describe('matchTotpCode', () => {
  const nowMs = 1_800_000_000_000;
  const step = totpStepAt(nowMs);
  const codeOf = (s: number) => totpCode(RFC_SECRET, s);

  it('takes the code of now and of one step before or after, and gives its step', () => {
    for (const s of [step - 1, step, step + 1]) {
      expect(matchTotpCode(RFC_SECRET, codeOf(s), { lastUsedStep: 0, nowMs })).toBe(s);
    }
  });

  it('refuses a code two steps away', () => {
    expect(matchTotpCode(RFC_SECRET, codeOf(step - 2), { lastUsedStep: 0, nowMs })).toBeNull();
    expect(matchTotpCode(RFC_SECRET, codeOf(step + 2), { lastUsedStep: 0, nowMs })).toBeNull();
  });

  it('refuses a code of the step taken last or of an earlier one: a code works once', () => {
    expect(matchTotpCode(RFC_SECRET, codeOf(step), { lastUsedStep: step, nowMs })).toBeNull();
    expect(
      matchTotpCode(RFC_SECRET, codeOf(step - 1), { lastUsedStep: step - 1, nowMs }),
    ).toBeNull();
    expect(matchTotpCode(RFC_SECRET, codeOf(step + 1), { lastUsedStep: step, nowMs })).toBe(
      step + 1,
    );
  });

  it('takes the spaces a person types and refuses anything but six digits', () => {
    const code = codeOf(step);
    expect(
      matchTotpCode(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { lastUsedStep: 0, nowMs }),
    ).toBe(step);
    expect(matchTotpCode(RFC_SECRET, code.slice(1), { lastUsedStep: 0, nowMs })).toBeNull();
    expect(matchTotpCode(RFC_SECRET, 'abcdef', { lastUsedStep: 0, nowMs })).toBeNull();
  });
});

describe('newTotpSecret', () => {
  it('is 20 random bytes in base32', () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(newTotpSecret()).not.toBe(secret);
  });
});

describe('otpauthUrl', () => {
  it('names the shop and the account and holds the settings every app takes', () => {
    const url = new URL(otpauthUrl({ secret: 'ABC', issuer: 'My Shop', account: 'a@b.com' }));

    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/My Shop:a@b.com');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      secret: 'ABC',
      issuer: 'My Shop',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});

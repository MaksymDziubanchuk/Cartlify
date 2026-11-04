import { describe, expect, it } from '@jest/globals';

import { isWithdrawalCode, withdrawalCodeOf, withdrawalLinkOf } from '@helpers/withdrawalCode.js';

const SECRET = 'a-secret-of-the-server';

describe('withdrawalCodeOf', () => {
  it('is twelve symbols in three groups of four, none of them 0, O, 1 or I', () => {
    for (let orderId = 1; orderId <= 200; orderId += 1) {
      expect(withdrawalCodeOf(orderId, SECRET)).toMatch(
        /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/,
      );
    }
  });

  it('is the same for the same order and secret, and differs for another order or another secret', () => {
    expect(withdrawalCodeOf(42, SECRET)).toBe(withdrawalCodeOf(42, SECRET));
    expect(withdrawalCodeOf(42, SECRET)).not.toBe(withdrawalCodeOf(43, SECRET));
    expect(withdrawalCodeOf(42, SECRET)).not.toBe(withdrawalCodeOf(42, `${SECRET}!`));
  });

  it('spreads over the whole alphabet and gives few repeats over many orders', () => {
    const codes = new Set<string>();
    const symbols = new Set<string>();
    for (let orderId = 1; orderId <= 2000; orderId += 1) {
      const code = withdrawalCodeOf(orderId, SECRET)!;
      codes.add(code);
      for (const symbol of code.replaceAll('-', '')) symbols.add(symbol);
    }

    expect(codes.size).toBe(2000);
    expect(symbols.size).toBe(32);
  });

  it('is none without a secret', () => {
    expect(withdrawalCodeOf(42, '')).toBeNull();
  });
});

describe('isWithdrawalCode', () => {
  const code = withdrawalCodeOf(42, SECRET)!;

  it('takes the code of the order, in any case, with or without the dashes and spaces', () => {
    expect(isWithdrawalCode(42, code, SECRET)).toBe(true);
    expect(isWithdrawalCode(42, code.toLowerCase(), SECRET)).toBe(true);
    expect(isWithdrawalCode(42, code.replaceAll('-', ''), SECRET)).toBe(true);
    expect(isWithdrawalCode(42, ` ${code.replaceAll('-', ' ')} `, SECRET)).toBe(true);
  });

  it('refuses the code of another order, a changed code, a short or long one, and things that are not text', () => {
    expect(isWithdrawalCode(43, code, SECRET)).toBe(false);
    expect(
      isWithdrawalCode(42, `${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`, SECRET),
    ).toBe(false);
    expect(isWithdrawalCode(42, code.slice(0, -2), SECRET)).toBe(false);
    expect(isWithdrawalCode(42, `${code}A`, SECRET)).toBe(false);
    for (const given of [undefined, null, 42, {}, [], '']) {
      expect(isWithdrawalCode(42, given, SECRET)).toBe(false);
    }
  });

  it('refuses every code while there is no secret, also one made with another', () => {
    expect(isWithdrawalCode(42, code, '')).toBe(false);
  });
});

describe('withdrawalLinkOf', () => {
  it('is the page of the order with the code after the #', () => {
    const link = withdrawalLinkOf(42);

    expect(link).toMatch(
      /\/orders\/42\/withdrawal#[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/,
    );
  });

  it('names the statement before the #, so the page opens on it', () => {
    expect(withdrawalLinkOf(42, 12)).toMatch(
      /\/orders\/42\/withdrawal\?return=12#[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/,
    );
  });
});

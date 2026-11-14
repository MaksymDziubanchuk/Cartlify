import { describe, expect, it } from '@jest/globals';

import { canManageMoneyOf } from '@helpers/moneyManager.js';

// what an answer tells about the right to handle the money: root always has it, an admin has it when
// root allowed the account and the account is not deleted, nobody else has it
describe('canManageMoneyOf', () => {
  it('is true for root, whatever the column keeps', () => {
    expect(canManageMoneyOf({ role: 'ROOT', canManageMoney: false })).toBe(true);
    expect(canManageMoneyOf({ role: 'ROOT', canManageMoney: true })).toBe(true);
  });

  it('is what the column keeps for an admin', () => {
    expect(canManageMoneyOf({ role: 'ADMIN', canManageMoney: true })).toBe(true);
    expect(canManageMoneyOf({ role: 'ADMIN', canManageMoney: false })).toBe(false);
  });

  it('is false for an admin whose account was deleted, as the database sees it', () => {
    expect(
      canManageMoneyOf({
        role: 'ADMIN',
        canManageMoney: true,
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).toBe(false);
    expect(canManageMoneyOf({ role: 'ADMIN', canManageMoney: true, deletedAt: null })).toBe(true);
  });

  it('is false for a user, also when the column says otherwise', () => {
    expect(canManageMoneyOf({ role: 'USER', canManageMoney: false })).toBe(false);
    expect(canManageMoneyOf({ role: 'USER', canManageMoney: true })).toBe(false);
  });
});

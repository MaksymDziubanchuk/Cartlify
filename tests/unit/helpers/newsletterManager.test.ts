import { describe, expect, it } from '@jest/globals';

import { canManageNewslettersOf } from '@helpers/newsletterManager.js';

// what an answer tells about the right to run the newsletters: root always has it, an admin has it
// when root allowed the account and the account is not deleted, nobody else has it
describe('canManageNewslettersOf', () => {
  it('is true for root, whatever the column keeps', () => {
    expect(canManageNewslettersOf({ role: 'ROOT', canManageNewsletters: false })).toBe(true);
    expect(canManageNewslettersOf({ role: 'ROOT', canManageNewsletters: true })).toBe(true);
  });

  it('is what the column keeps for an admin', () => {
    expect(canManageNewslettersOf({ role: 'ADMIN', canManageNewsletters: true })).toBe(true);
    expect(canManageNewslettersOf({ role: 'ADMIN', canManageNewsletters: false })).toBe(false);
  });

  it('is false for an admin whose account was deleted, as the database sees it', () => {
    expect(
      canManageNewslettersOf({
        role: 'ADMIN',
        canManageNewsletters: true,
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).toBe(false);
    expect(
      canManageNewslettersOf({ role: 'ADMIN', canManageNewsletters: true, deletedAt: null }),
    ).toBe(true);
  });

  it('is false for a user, also when the column says otherwise', () => {
    expect(canManageNewslettersOf({ role: 'USER', canManageNewsletters: false })).toBe(false);
    expect(canManageNewslettersOf({ role: 'USER', canManageNewsletters: true })).toBe(false);
  });
});

import { describe, expect, it } from '@jest/globals';

import {
  WITHDRAWAL_RULES,
  parseWithdrawalRule,
  withdrawalOf,
  withdrawalRightOf,
} from '@helpers/withdrawal.js';

import { thrownBy } from '../../helpers/errors.js';

// the rule of withdrawal of a product and what it means to a buyer: the seven rules of the law,
// the kind each one makes (free, only while sealed, none) and the reading of a rule an admin sends

describe('WITHDRAWAL_RULES', () => {
  it('are the seven of the database, in its order', () => {
    expect([...WITHDRAWAL_RULES]).toEqual([
      'allowed',
      'sealed_hygiene',
      'sealed_media',
      'mixed',
      'perishable',
      'personalised',
      'periodical',
    ]);
  });
});

describe('withdrawalRightOf', () => {
  it.each([
    ['allowed', 'full'],
    ['sealed_hygiene', 'conditional'],
    ['sealed_media', 'conditional'],
    ['mixed', 'conditional'],
    ['perishable', 'none'],
    ['personalised', 'none'],
    ['periodical', 'none'],
  ] as const)('makes %s a right that is %s', (rule, right) => {
    expect(withdrawalRightOf(rule)).toBe(right);
  });

  it('gives a kind to every rule', () => {
    for (const rule of WITHDRAWAL_RULES) {
      expect(['full', 'conditional', 'none']).toContain(withdrawalRightOf(rule));
    }
  });
});

describe('withdrawalOf', () => {
  it('gives the rule and its kind together, what an answer shows a buyer', () => {
    expect(withdrawalOf('sealed_media')).toEqual({ rule: 'sealed_media', right: 'conditional' });
    expect(withdrawalOf('allowed')).toEqual({ rule: 'allowed', right: 'full' });
  });
});

describe('parseWithdrawalRule', () => {
  it.each(WITHDRAWAL_RULES)('takes %s', (rule) => {
    expect(parseWithdrawalRule(rule)).toBe(rule);
  });

  it.each([
    ['text with spaces around the rule', ' mixed ', 'mixed'],
    ['an empty text', '', null],
    ['spaces only', '   ', null],
    ['the word null', 'null', null],
    ['null itself', null, null],
  ])('reads %s as the rule it gives up or names', (_case, raw, expected) => {
    expect(parseWithdrawalRule(raw)).toBe(expected);
  });

  it('leaves a field that was not sent alone', () => {
    expect(parseWithdrawalRule(undefined)).toBeUndefined();
  });

  it.each(['Allowed', 'sealed', 'sealed-hygiene', 'none', '0', 7, true, {}, []])(
    'refuses %p with WITHDRAWAL_RULE_INVALID',
    (raw) => {
      const err = thrownBy(() => parseWithdrawalRule(raw));

      expect(err).toMatchObject({ errorCode: 'WITHDRAWAL_RULE_INVALID', statusCode: 400 });
    },
  );
});

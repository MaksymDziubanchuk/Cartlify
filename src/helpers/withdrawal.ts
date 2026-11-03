import { BadRequestError } from '@utils/errors.js';

// the rule of withdrawal of a product (Directive 2011/83, art. 16): what the law lets a buyer do
// with the goods when they withdraw from the purchase. The rule is a value of the database
// (WithdrawalRule); the kind it makes is derived here and stored nowhere

export const WITHDRAWAL_RULES = [
  'allowed',
  'sealed_hygiene',
  'sealed_media',
  'mixed',
  'perishable',
  'personalised',
  'periodical',
] as const;

export type WithdrawalRuleName = (typeof WITHDRAWAL_RULES)[number];

// full: taken back freely; conditional: only while the seal is unbroken; none: not at all
export type WithdrawalRight = 'full' | 'conditional' | 'none';

// where the rule of a product comes from: its own, the nearest category above it that has one, or
// the default
export type WithdrawalSource = 'product' | 'category' | 'default';

export function withdrawalRightOf(rule: WithdrawalRuleName): WithdrawalRight {
  switch (rule) {
    case 'allowed':
      return 'full';
    case 'sealed_hygiene':
    case 'sealed_media':
    case 'mixed':
      return 'conditional';
    case 'perishable':
    case 'personalised':
    case 'periodical':
      return 'none';
  }
}

// what an answer shows a buyer: the rule, which the page words, and the kind it makes
export const withdrawalOf = (
  rule: WithdrawalRuleName,
): { rule: WithdrawalRuleName; right: WithdrawalRight } => ({
  rule,
  right: withdrawalRightOf(rule),
});

// the rule an admin sends for a product or a category: a field not sent is left alone (undefined),
// an empty text, the word null or null itself gives the rule up (null: the product follows its
// category, the category follows the one above it), anything else has to be one of the rules
export function parseWithdrawalRule(raw: unknown): WithdrawalRuleName | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '' || text === 'null') return null;
    if ((WITHDRAWAL_RULES as readonly string[]).includes(text)) return text as WithdrawalRuleName;
  }

  throw new BadRequestError('WITHDRAWAL_RULE_INVALID', { allowed: [...WITHDRAWAL_RULES] });
}

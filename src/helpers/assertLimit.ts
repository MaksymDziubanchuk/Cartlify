import { BadRequestError } from '@utils/errors.js';

export function assertLimit(limit: unknown): number {
  // enforce integer limit and cap to prevent heavy queries;
  // only a number or a digit string, Number() alone also reads true as 1 and [5] as 5
  const normalizedLimit =
    typeof limit === 'number'
      ? limit
      : typeof limit === 'string' && /^\d+$/.test(limit.trim())
        ? Number(limit.trim())
        : Number.NaN;

  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1) {
    throw new BadRequestError('LIMIT_INVALID');
  }

  return Math.min(normalizedLimit, 100);
}

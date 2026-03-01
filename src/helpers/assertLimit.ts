import { BadRequestError } from '@utils/errors.js';

export function assertLimit(limit: unknown): number {
  // enforce integer limit and cap to prevent heavy queries
  const n = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestError('LIMIT_INVALID');
  return Math.min(n, 100);
}

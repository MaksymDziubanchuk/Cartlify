import { AppError } from '@utils/errors.js';

export function assertLimit(limit: unknown): number {
  // enforce integer limit and cap to prevent heavy queries
  const n = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isInteger(n) || n < 1) throw new AppError('LIMIT_INVALID', 400);
  return Math.min(n, 100);
}

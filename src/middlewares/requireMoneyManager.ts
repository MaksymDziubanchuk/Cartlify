import type { FastifyRequest } from 'fastify';

import { isMoneyManager } from '@db/moneyManager.helper.js';
import { ForbiddenError } from '@utils/errors.js';

// The guard of every route of the money that root alone had (money sent outside the app, rows closed
// without money, the decisions on refunds made by hand and on the money of a bank, the holds root lets
// go): a preHandler after authGuard and requireRole(['ADMIN', 'ROOT']). Root passes. An admin passes
// only when root allowed the account, and that is asked of the database at every request, never read
// from the token (a token holds the role, not the right), so a right root took away stops at once, in
// a session that is open too. Anyone else, and an admin without the right, get 403
// MONEY_MANAGER_REQUIRED, which the swagger names for every route that has the guard
// (src/plugins/openapi.plugin.ts). The functions of the database check the same right again
export default async function requireMoneyManager(req: FastifyRequest): Promise<void> {
  const user = req.user;

  if (user?.role === 'ROOT') return;

  if (user?.role === 'ADMIN' && typeof user.id === 'number' && Number.isInteger(user.id)) {
    if (await isMoneyManager({ userId: user.id, role: 'ADMIN' })) return;
  }

  throw new ForbiddenError('MONEY_MANAGER_REQUIRED');
}

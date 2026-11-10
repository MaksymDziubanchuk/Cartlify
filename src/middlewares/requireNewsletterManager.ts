import type { FastifyRequest } from 'fastify';

import { isNewsletterManager } from '@db/newsletterManager.helper.js';
import { ForbiddenError } from '@utils/errors.js';

// The guard of every route of the newsletters (subscribers, the list of blocked addresses,
// newsletters): a preHandler after authGuard and requireRole(['ADMIN', 'ROOT']). Root passes. An
// admin passes only when root allowed the account, and that is asked of the database at every
// request, never read from the token (a token holds the role, not the right), so a right root took
// away stops at once, in a session that is open too. Anyone else, and an admin without the right,
// get 403 NEWSLETTER_MANAGER_REQUIRED, which the swagger names for every route that has the guard
// (src/plugins/openapi.plugin.ts)
export default async function requireNewsletterManager(req: FastifyRequest): Promise<void> {
  const user = req.user;

  if (user?.role === 'ROOT') return;

  if (user?.role === 'ADMIN' && typeof user.id === 'number' && Number.isInteger(user.id)) {
    if (await isNewsletterManager({ userId: user.id, role: 'ADMIN' })) return;
  }

  throw new ForbiddenError('NEWSLETTER_MANAGER_REQUIRED');
}

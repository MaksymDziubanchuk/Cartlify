import { ForbiddenError } from '@utils/errors.js';

import type { Role } from 'types/user.js';

export function assertAdminActor(actorId: unknown, actorRole: Role) {
  // validate actor context for rls and admin-only actions
  if (!Number.isInteger(actorId)) throw new ForbiddenError('ACTOR_ID_INVALID');
  if (actorRole !== 'ADMIN' && actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN');
}

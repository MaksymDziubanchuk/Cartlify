import { FastifyRequest } from 'fastify';
import { ForbiddenError } from '@utils/errors.js';
import { Role } from 'types/user.js';

// the guard knows its roles, so the swagger document names INSUFFICIENT_ROLE with them
export type RoleGuard = ((req: FastifyRequest) => Promise<void>) & {
  readonly allowedRoles: readonly Role[];
};

export default function requireRole(roles: readonly Role[]): RoleGuard {
  async function roleGuard(req: FastifyRequest) {
    if (req.user?.role && roles.includes(req.user?.role)) {
      return;
    }

    throw new ForbiddenError('INSUFFICIENT_ROLE');
  }
  return Object.assign(roleGuard, { allowedRoles: roles });
}

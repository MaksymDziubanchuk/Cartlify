import { FastifyRequest, FastifyReply } from 'fastify';
import { ForbiddenError } from '@utils/errors.js';
import { Role } from 'types/user.js';

export default function requireRole(roles: Role[]) {
  async function roleGuard(req: FastifyRequest) {
    if (req.user?.role && roles.includes(req.user?.role)) {
      return;
    }

    throw new ForbiddenError();
  }
  return roleGuard;
}

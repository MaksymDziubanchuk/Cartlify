import { FastifyRequest, FastifyReply } from 'fastify';
import { UnauthorizedError } from '@utils/errors.js';
import { randomUUID } from 'node:crypto';

export default async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = req.headers['authorization'];

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      // TODO: verify token → get userId + role from DB
      req.user = { id: 'real-user-id-from-db', email: 'fwwfw', role: 'USER' };
    } else {
      const guestId = randomUUID();
      req.user = { id: guestId, role: 'GUEST' };
    }
  } catch (error) {
    throw new UnauthorizedError('Unauthorized');
  }
}

import { FastifyRequest, FastifyReply } from 'fastify';
import { UnauthorizedError } from '@utils/errors.js';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken } from '@utils/jwt.js';

export default async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = req.headers.authorization;

    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (!token) throw new UnauthorizedError('Unauthorized');

      try {
        const { userId, role } = verifyAccessToken(token);
        req.user = { id: userId, role };
        return;
      } catch {
        throw new UnauthorizedError('Unauthorized');
      }
    } else {
      const guestId = randomUUID();
      req.user = { id: guestId, role: 'GUEST' };
    }
  } catch (error) {
    throw new UnauthorizedError('Unauthorized');
  }
}

import { FastifyRequest, FastifyReply } from 'fastify';
import { ForbiddenError } from '@utils/errors.js';

export default async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  try {
    req.user = { id: '1', email: 'wrgwfgw', role: 'USER' };
    return;
  } catch (error) {
    throw new ForbiddenError('Unauthorized');
  }
}

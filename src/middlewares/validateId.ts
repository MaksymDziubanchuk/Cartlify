import { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { BadRequestError } from '@utils/errors.js';

export default function validateId(paramName: string): preHandlerHookHandler {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const value = (req.params as Record<string, string>)[paramName];
    const num = Number(value);

    if (!Number.isInteger(num) || num <= 0 || Number.isNaN(num)) {
      throw new BadRequestError(`Invalid ${paramName}`);
    }
  };
}

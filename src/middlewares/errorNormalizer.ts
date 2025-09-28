import { FastifyRequest, FastifyReply, FastifyInstance, FastifyError } from 'fastify';
import { AppError } from '@utils/errors.js';

export default async function errorNormalizer(app: FastifyInstance, opt: unknown) {
  app.setErrorHandler((error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    req.log.error(error);
    const statusCode = error instanceof AppError ? error.statusCode : (error.statusCode ?? 500);
    return reply.status(statusCode).send({
      code: statusCode,
      message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : error.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
    });
  });
}

import { FastifyRequest, FastifyReply, FastifyInstance, FastifyError } from 'fastify';
import { AppError } from '@utils/errors.js';

export default function errorNormalizer(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    req.log.error(error);

    const statusCode = error instanceof AppError ? error.statusCode : (error.statusCode ?? 500);

    const payload: { code: number; message: string; stack?: string } = {
      code: statusCode,
      message:
        process.env.NODE_ENV === 'production' && statusCode >= 500
          ? 'Something went wrong'
          : error.message,
    };

    if (process.env.NODE_ENV !== 'production' && statusCode >= 500 && error.stack) {
      payload.stack = error.stack;
    }

    return reply.status(statusCode).send(payload);
  });
}

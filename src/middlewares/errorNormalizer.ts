import { FastifyRequest, FastifyReply, FastifyInstance, FastifyError } from 'fastify';
import { AppError } from '@utils/errors.js';

// normalize errors to json response
export default function errorNormalizer(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    req.log.error(error);

    // map app errors to status
    const statusCode = error instanceof AppError ? error.statusCode : (error.statusCode ?? 500);

    const payload: { code: number; message: string; stack?: string } = {
      code: statusCode,
      // hide 500 messages in prod
      message:
        process.env.NODE_ENV === 'production' && statusCode >= 500
          ? 'Something went wrong'
          : error.message,
    };

    // include stack only in dev
    if (process.env.NODE_ENV !== 'production' && statusCode >= 500 && error.stack) {
      payload.stack = error.stack;
    }

    return reply.status(statusCode).send(payload);
  });
}

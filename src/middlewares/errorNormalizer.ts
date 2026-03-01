import type { FastifyRequest, FastifyReply, FastifyInstance, FastifyError } from 'fastify';
import { isAppError, ApiErrorResponse } from '@utils/errors.js';

function defaultMessage(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 409:
      return 'Conflict';
    case 422:
      return 'Unprocessable Entity';
    case 429:
      return 'Too Many Requests';
    default:
      return 'Internal Server Error';
  }
}

// normalize errors to a stable api shape
export default function errorNormalizer(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const statusCode = isAppError(error) ? error.statusCode : (error.statusCode ?? 500);

    // log raw error and optional cause
    if (isAppError(error) && error.cause !== undefined) {
      req.log.error({ err: error, cause: error.cause }, 'request failed');
    } else {
      req.log.error({ err: error }, 'request failed');
    }

    const payload: ApiErrorResponse = {
      code: statusCode,
      errorCode: isAppError(error)
        ? error.errorCode
        : statusCode >= 500
          ? 'INTERNAL_ERROR'
          : 'ERROR',
      message: isAppError(error) ? error.message : defaultMessage(statusCode),
      reqId: req.id,
      ...(isAppError(error) && error.expose && error.details !== undefined
        ? { details: error.details }
        : {}),
    };

    // include stack only in dev for 5xx
    if (process.env.NODE_ENV !== 'production' && statusCode >= 500 && error.stack) {
      (payload as ApiErrorResponse & { stack?: string }).stack = error.stack;
    }

    return reply.status(statusCode).send(payload);
  });
}

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
    case 503:
      return 'Service Unavailable';
    default:
      return 'Internal Server Error';
  }
}

// one entry per failed rule of a request schema, so a client can mark the wrong field
type ValidationDetail = { in: string; field: string; message: string };

function validationDetails(error: FastifyError): ValidationDetail[] {
  const where = error.validationContext ?? 'request';

  return (error.validation ?? []).map((issue) => {
    const params = issue.params as Record<string, unknown>;

    // '/scope/minPrice' -> 'scope.minPrice'; a missing field has no path of its own;
    // unknown fields never get here, fastify strips them (ajv removeAdditional)
    const path = issue.instancePath.replace(/^\//, '').replaceAll('/', '.');
    const missing = typeof params?.missingProperty === 'string' ? params.missingProperty : '';
    const field = [path, missing].filter(Boolean).join('.');

    return { in: where, field, message: issue.message ?? 'is invalid' };
  });
}

// normalize errors to a stable api shape
export default function errorNormalizer(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    // a request that failed its route schema (body, query, params or headers)
    const isValidation = !isAppError(error) && Array.isArray(error.validation);

    const statusCode = isAppError(error) ? error.statusCode : (error.statusCode ?? 500);

    const payload: ApiErrorResponse = {
      code: statusCode,
      errorCode: isAppError(error)
        ? error.errorCode
        : isValidation
          ? 'VALIDATION_ERROR'
          : statusCode >= 500
            ? 'INTERNAL_ERROR'
            : 'ERROR',
      message: isAppError(error) ? error.message : defaultMessage(statusCode),
      reqId: req.id,
      ...(isAppError(error) && error.expose && error.details !== undefined
        ? { details: error.details }
        : {}),
      ...(isValidation ? { details: validationDetails(error) } : {}),
    };

    if (statusCode >= 500) {
      // a server failure: the raw error with its stack; pino adds an Error cause to err.message
      // and err.stack itself, a cause of another kind is logged next to it
      const cause = isAppError(error) ? error.cause : undefined;
      const extra = cause !== undefined && !(cause instanceof Error) ? { cause } : {};

      req.log.error({ err: error, ...extra }, 'request failed');
    } else {
      // a client error is expected traffic: one short info line without a stack;
      // the query string stays out of the log, it may carry tokens
      req.log.info(
        {
          statusCode,
          errorCode: payload.errorCode,
          method: req.method,
          path: req.url.split('?')[0],
          ...(isValidation ? { details: payload.details } : {}),
        },
        'request rejected',
      );
    }

    // include stack only in dev for 5xx
    if (process.env.NODE_ENV !== 'production' && statusCode >= 500 && error.stack) {
      (payload as ApiErrorResponse & { stack?: string }).stack = error.stack;
    }

    return reply.status(statusCode).send(payload);
  });
}

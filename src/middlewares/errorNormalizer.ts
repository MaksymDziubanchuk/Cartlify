import { STATUS_CODES } from 'node:http';
import type { FastifyRequest, FastifyReply, FastifyInstance, FastifyError } from 'fastify';
import { isAppError, ApiErrorResponse } from '@utils/errors.js';
import { maskUrlSecrets } from '@helpers/maskUrlSecrets.js';

// the swagger contract: message is the standard http phrase of the status, for every error;
// a status without a phrase gets the one of its class
function httpPhrase(statusCode: number): string {
  return STATUS_CODES[statusCode] ?? (statusCode < 500 ? 'Bad Request' : 'Internal Server Error');
}

// the codes our error classes use for these statuses, so an error from fastify or a plugin
// carries the same code as our own error with that status
const STATUS_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

// errorCode for an error that is not ours: from its status, for example PAYLOAD_TOO_LARGE
// or UNSUPPORTED_MEDIA_TYPE; any other server failure stays INTERNAL_ERROR
function statusErrorCode(statusCode: number): string {
  const known = STATUS_ERROR_CODES[statusCode];
  if (known) return known;
  if (statusCode >= 500) return 'INTERNAL_ERROR';

  const phrase = STATUS_CODES[statusCode];
  return phrase
    ? phrase
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
    : 'BAD_REQUEST';
}

// plugin errors whose own code tells the client more than the status does
const PLUGIN_ERROR_CODES: Record<string, string> = {
  // no csrf token, a wrong one or no secret cookie: the page takes a new token
  // from GET /api/auth/csrf and repeats the request
  FST_CSRF_MISSING_SECRET: 'CSRF_TOKEN_INVALID',
  FST_CSRF_INVALID_TOKEN: 'CSRF_TOKEN_INVALID',
};

// an error status must be 4xx or 5xx; anything else on an error is a server fault,
// the same rule fastify itself follows
function errorStatus(error: FastifyError): number {
  const raw = error.statusCode;
  return typeof raw === 'number' && raw >= 400 && raw <= 599 ? raw : 500;
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

    const statusCode = errorStatus(error);

    const payload: ApiErrorResponse = {
      code: statusCode,
      errorCode: isAppError(error)
        ? error.errorCode
        : isValidation
          ? 'VALIDATION_ERROR'
          : (PLUGIN_ERROR_CODES[error.code] ?? statusErrorCode(statusCode)),
      message: httpPhrase(statusCode),
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
      // the query may carry tokens, their values are hidden
      req.log.info(
        {
          statusCode,
          errorCode: payload.errorCode,
          method: req.method,
          url: maskUrlSecrets(req.url),
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

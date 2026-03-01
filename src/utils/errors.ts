export type ErrorDetails = Record<string, unknown> | unknown[] | string;

export type ApiErrorResponse = {
  code: number;
  errorCode: string;
  message: string; // standard http phrase for status code
  details?: ErrorDetails;
  reqId?: string;
};

type AppErrorArgs = {
  statusCode: number;
  errorCode: string;
  message: string;

  // safe payload for client response
  details?: ErrorDetails;

  // raw error for server logs
  cause?: unknown;

  // hide details for 5xx by default
  expose?: boolean;
};

// application error with stable error code and status code
export class AppError extends Error {
  readonly statusCode: number;
  readonly errorCode: string;

  // optional payload for debugging and client ui
  readonly details: ErrorDetails | undefined;

  // original error for logging only
  readonly cause: unknown | undefined;

  // controls whether details can be returned to the client
  readonly expose: boolean;

  constructor(args: AppErrorArgs) {
    super(args.message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;

    this.statusCode = args.statusCode;
    this.errorCode = args.errorCode;

    // attach safe context for non-5xx responses
    this.details = args.details;

    // attach raw cause for server logs
    this.cause = args.cause;

    this.expose = typeof args.expose === 'boolean' ? args.expose : args.statusCode < 500;
  }
}

// 400 bad request
export class BadRequestError extends AppError {
  constructor(errorCode = 'BAD_REQUEST', details?: ErrorDetails, cause?: unknown) {
    super({
      statusCode: 400,
      errorCode,
      message: 'Bad Request',
      ...(details !== undefined ? { details } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

// 401 unauthorized
export class UnauthorizedError extends AppError {
  constructor(errorCode = 'UNAUTHORIZED', details?: ErrorDetails, cause?: unknown) {
    super({
      statusCode: 401,
      errorCode,
      message: 'Unauthorized',
      ...(details !== undefined ? { details } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

// 401 access token expired
export class AccessTokenExpiredError extends UnauthorizedError {
  constructor(details?: ErrorDetails, cause?: unknown) {
    super('ACCESS_TOKEN_EXPIRED', details, cause);
  }
}

// 403 forbidden
export class ForbiddenError extends AppError {
  constructor(errorCode = 'FORBIDDEN', details?: ErrorDetails, cause?: unknown) {
    super({
      statusCode: 403,
      errorCode,
      message: 'Forbidden',
      ...(details !== undefined ? { details } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

// 404 not found
export class NotFoundError extends AppError {
  constructor(errorCode = 'NOT_FOUND', details?: ErrorDetails, cause?: unknown) {
    super({
      statusCode: 404,
      errorCode,
      message: 'Not Found',
      ...(details !== undefined ? { details } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

// 409 conflict
export class ConflictError extends AppError {
  constructor(errorCode = 'CONFLICT', details?: ErrorDetails, cause?: unknown) {
    super({
      statusCode: 409,
      errorCode,
      message: 'Conflict',
      ...(details !== undefined ? { details } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

// 409 already authenticated
export class AlreadyAuthenticatedError extends ConflictError {
  constructor(details?: ErrorDetails, cause?: unknown) {
    super('ALREADY_AUTHENTICATED', details, cause);
  }
}

// 409 resource busy
export class ResourceBusyError extends ConflictError {
  constructor(details?: ErrorDetails, cause?: unknown) {
    super('RESOURCE_BUSY', details, cause);
  }
}

// 429 too many requests
export class TooManyRequestsError extends AppError {
  constructor(errorCode = 'RATE_LIMITED', details?: ErrorDetails, cause?: unknown) {
    super({
      statusCode: 429,
      errorCode,
      message: 'Too Many Requests',
      ...(details !== undefined ? { details } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

// 500 internal server error
export class InternalError extends AppError {
  constructor(details?: ErrorDetails, cause?: unknown) {
    super({
      statusCode: 500,
      errorCode: 'INTERNAL_ERROR',
      message: 'Internal Server Error',
      ...(details !== undefined ? { details } : {}),
      ...(cause !== undefined ? { cause } : {}),
      expose: false,
    });
  }
}

// checks error class name for narrow matches
export function isErrorNamed(err: unknown, name: string): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === name;
}

// checks for application error shape
export function isAppError(err: unknown): err is AppError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as { statusCode?: unknown }).statusCode === 'number' &&
    'errorCode' in err &&
    typeof (err as { errorCode?: unknown }).errorCode === 'string'
  );
}

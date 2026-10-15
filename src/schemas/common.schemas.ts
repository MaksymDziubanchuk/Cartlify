export const messageResponseSchema = {
  $id: 'messageResponseSchema',
  type: 'object',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
  additionalProperties: false,
} as const;

export const errorResponseSchema = {
  $id: 'errorResponseSchema',
  type: 'object',
  // shown in swagger for every error response, the frontend contract for errors
  description:
    'Every api error has this shape; branch on errorCode, never on message. ' +
    'VALIDATION_ERROR (400): the request does not match the route schema, details is a list of ' +
    '{ in, field, message } for every failed rule, in is body, querystring, params or headers. ' +
    'ROUTE_NOT_FOUND (404): no route for this method and url, the response also has method and url. ' +
    'Errors raised before the route runs, by the framework or a plugin, get a code from the status: ' +
    'BAD_REQUEST (400, for example a body that is not valid json), PAYLOAD_TOO_LARGE (413), ' +
    'UNSUPPORTED_MEDIA_TYPE (415), RATE_LIMITED (429, too many requests from this address), ' +
    'SERVICE_UNAVAILABLE (503); any other server failure is INTERNAL_ERROR (500). ' +
    'Every other errorCode comes from the route itself, for example PRODUCT_NOT_FOUND or ' +
    'REVIEW_ALREADY_EXISTS, see the route description.',
  properties: {
    code: { type: 'integer', description: 'HTTP status code.' },

    // stable machine-readable code
    errorCode: {
      type: 'string',
      description:
        'Stable machine-readable code, for example VALIDATION_ERROR, ROUTE_NOT_FOUND, ' +
        'RATE_LIMITED, PRODUCT_NOT_FOUND.',
    },

    // standard http phrase for status code
    message: { type: 'string', description: 'Standard HTTP phrase for the status code.' },

    // optional safe payload for ui and debugging
    details: {
      description:
        'Extra data for the ui. For VALIDATION_ERROR: an array of { in, field, message }, ' +
        'field is a dotted path like scope.minPrice, empty when the rule is about the whole object.',
      anyOf: [
        { type: 'object', additionalProperties: true },
        { type: 'array' },
        { type: 'string' },
      ],
    },

    // optional request id for log correlation
    reqId: {
      type: 'string',
      description: 'Request id, quote it to find the request in server logs.',
    },

    // only for ROUTE_NOT_FOUND
    method: { type: 'string', description: 'Only for ROUTE_NOT_FOUND: the request method.' },
    url: { type: 'string', description: 'Only for ROUTE_NOT_FOUND: the requested url.' },

    // optional stack for dev only
    stack: { type: 'string', description: 'Only outside production, for 5xx errors.' },
  },
  // openapi keeps a single example on a shared component, examples would be dropped
  example: {
    code: 400,
    errorCode: 'VALIDATION_ERROR',
    message: 'Bad Request',
    reqId: 'req-1a',
    details: [{ in: 'body', field: 'email', message: 'must match format "email"' }],
  },
  required: ['code', 'errorCode', 'message'],
  additionalProperties: false,
} as const;

export const commonSchemas = [messageResponseSchema, errorResponseSchema];

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
  properties: {
    code: { type: 'integer' },

    // stable machine-readable code
    errorCode: { type: 'string' },

    // standard http phrase for status code
    message: { type: 'string' },

    // optional safe payload for ui and debugging
    details: {
      anyOf: [
        { type: 'object', additionalProperties: true },
        { type: 'array' },
        { type: 'string' },
      ],
    },

    // optional request id for log correlation
    reqId: { type: 'string' },

    // optional stack for dev only
    stack: { type: 'string' },
  },
  required: ['code', 'errorCode', 'message'],
  additionalProperties: false,
} as const;

export const commonSchemas = [messageResponseSchema, errorResponseSchema];

const messageResponseSchema = {
  $id: 'messageResponse',
  type: 'object',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
} as const;

const errorResposeSchema = {
  $id: 'errorResponse',
  type: 'object',
  properties: {
    code: { type: 'integer' },
    message: { type: 'string' },
    stack: { type: 'string' },
  },
  required: ['code', 'message'],
} as const;

export const commonSchemas = {
  messageResponseSchema,
  errorResposeSchema,
};

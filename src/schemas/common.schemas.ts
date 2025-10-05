export const messageResponseSchema = {
  $id: 'messageResponseSchema',
  type: 'object',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
} as const;

export const errorResposeSchema = {
  $id: 'errorResponseSchema',
  type: 'object',
  properties: {
    code: { type: 'integer' },
    message: { type: 'string' },
    stack: { type: 'string' },
  },
  required: ['code', 'message'],
} as const;

export const commonSchemas = [messageResponseSchema, errorResposeSchema];

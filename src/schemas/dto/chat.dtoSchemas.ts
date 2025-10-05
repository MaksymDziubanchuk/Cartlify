export const chatsGetQuerySchema = {
  $id: 'chatsGetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'number', minimum: 1 },
    limit: { type: 'number', minimum: 1 },
    status: { type: 'string', enum: ['open', 'closed'] },
    type: { type: 'string', enum: ['bot', 'admin'] },
  },
} as const;

export const chatsChatItemSchema = {
  $id: 'chatsChatItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['bot', 'admin'] },
    status: { type: 'string', enum: ['open', 'closed'] },
    lastMessageAt: { type: 'string', format: 'date-time' },
    unreadCount: { type: 'number' },
    lastMessagePreview: { type: 'string' },
  },
  required: ['id', 'type', 'status', 'lastMessageAt'],
} as const;

export const chatsGetResponseSchema = {
  $id: 'chatsGetResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'chatsChatItemSchema#' } },
    page: { type: 'number' },
    limit: { type: 'number' },
    total: { type: 'number' },
  },
  required: ['items'],
} as const;

export const chatsDtoSchemas = [chatsGetQuerySchema, chatsChatItemSchema, chatsGetResponseSchema];

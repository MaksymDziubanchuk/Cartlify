const chatStatusSchema = ['open', 'closed'] as const;
const chatTypeSchema = ['bot', 'admin'] as const;
const chatSenderTypeSchema = ['user', 'admin', 'bot', 'guest'] as const;

const chatThreadIdParamsSchema = {
  $id: 'chatThreadIdParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    threadId: { type: 'string', format: 'uuid' },
  },
  required: ['threadId'],
} as const;

const chatPaginationQuerySchema = {
  $id: 'chatPaginationQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'number', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
} as const;

const adminChatThreadsQuerySchema = {
  $id: 'adminChatThreadsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    queue: { type: 'string', enum: ['waiting', 'active'] },
  },
} as const;

const chatThreadItemSchema = {
  $id: 'chatThreadItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    userId: { type: 'number', nullable: true },
    guestId: { type: 'string', format: 'uuid', nullable: true },
    type: { type: 'string', enum: chatTypeSchema },
    status: { type: 'string', enum: chatStatusSchema },
    lastMessageAt: { type: 'string', format: 'date-time' },
    unreadCount: { type: 'number' },
    adminRequestedAt: { type: 'string', format: 'date-time', nullable: true },
    adminUnreadSince: { type: 'string', format: 'date-time', nullable: true },
    lastMessagePreview: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'userId',
    'guestId',
    'type',
    'status',
    'lastMessageAt',
    'unreadCount',
    'adminRequestedAt',
    'adminUnreadSince',
    'lastMessagePreview',
    'createdAt',
    'updatedAt',
  ],
} as const;

const chatMessageItemSchema = {
  $id: 'chatMessageItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    threadId: { type: 'string', format: 'uuid' },
    senderId: { type: 'number', nullable: true },
    senderType: { type: 'string', enum: chatSenderTypeSchema },
    content: { type: 'string' },
    isRead: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'threadId', 'senderId', 'senderType', 'content', 'isRead', 'createdAt'],
} as const;

const chatWsInfoSchema = {
  $id: 'chatWsInfoSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string' },
    threadId: { type: 'string', format: 'uuid' },
  },
  required: ['url', 'threadId'],
} as const;

const currentChatResponseSchema = {
  $id: 'currentChatResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    thread: { $ref: 'chatThreadItemSchema#' },
    messages: {
      type: 'array',
      items: { $ref: 'chatMessageItemSchema#' },
    },
    nextCursor: {
      type: ['string', 'null'],
      description:
        'Cursor of the messages before these, for GET /api/chat/threads/{threadId}/messages; null at the start of the chat.',
    },
    ws: { $ref: 'chatWsInfoSchema#' },
  },
  required: ['thread', 'messages', 'nextCursor', 'ws'],
} as const;

const chatThreadMessagesQuerySchema = {
  $id: 'chatThreadMessagesQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: {
      type: 'string',
      description:
        'nextCursor of the page after this one (CURSOR_INVALID); without it the newest messages.',
    },
  },
} as const;

const chatThreadMessagesResponseSchema = {
  $id: 'chatThreadMessagesResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    messages: {
      type: 'array',
      description: 'Up to 50 messages, oldest first.',
      items: { $ref: 'chatMessageItemSchema#' },
    },
    nextCursor: {
      type: ['string', 'null'],
      description: 'Cursor of the messages before these; null at the start of the chat.',
    },
  },
  required: ['messages', 'nextCursor'],
} as const;

const adminChatThreadsResponseSchema = {
  $id: 'adminChatThreadsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: { $ref: 'chatThreadItemSchema#' },
    },
    page: { type: 'number' },
    limit: { type: 'number' },
    total: { type: 'number' },
  },
  required: ['items', 'page', 'limit', 'total'],
} as const;

const adminChatThreadResponseSchema = {
  $id: 'adminChatThreadResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    thread: { $ref: 'chatThreadItemSchema#' },
    messages: {
      type: 'array',
      description: 'The newest 50 messages, oldest first.',
      items: { $ref: 'chatMessageItemSchema#' },
    },
    nextCursor: {
      type: ['string', 'null'],
      description:
        'Cursor of the messages before these, for GET /api/chat/threads/{threadId}/messages; null at the start of the chat.',
    },
    previousThreads: {
      type: 'array',
      items: { $ref: 'chatThreadItemSchema#' },
    },
  },
  required: ['thread', 'messages', 'nextCursor', 'previousThreads'],
} as const;

const closeChatThreadResponseSchema = {
  $id: 'closeChatThreadResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    thread: { $ref: 'chatThreadItemSchema#' },
  },
  required: ['thread'],
} as const;

export const chatsDtoSchemas = [
  chatThreadIdParamsSchema,
  chatPaginationQuerySchema,
  adminChatThreadsQuerySchema,
  chatThreadItemSchema,
  chatMessageItemSchema,
  chatWsInfoSchema,
  currentChatResponseSchema,
  chatThreadMessagesQuerySchema,
  chatThreadMessagesResponseSchema,
  adminChatThreadsResponseSchema,
  adminChatThreadResponseSchema,
  closeChatThreadResponseSchema,
];

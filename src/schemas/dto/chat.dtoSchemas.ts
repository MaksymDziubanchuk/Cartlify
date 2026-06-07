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
    limit: { type: 'number', minimum: 1 },
  },
} as const;

const adminChatThreadsQuerySchema = {
  $id: 'adminChatThreadsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'number', minimum: 1 },
    limit: { type: 'number', minimum: 1 },
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
  required: [
    'id',
    'threadId',
    'senderId',
    'senderType',
    'content',
    'isRead',
    'createdAt',
  ],
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
    ws: { $ref: 'chatWsInfoSchema#' },
  },
  required: ['thread', 'messages', 'ws'],
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
      items: { $ref: 'chatMessageItemSchema#' },
    },
    previousThreads: {
      type: 'array',
      items: { $ref: 'chatThreadItemSchema#' },
    },
  },
  required: ['thread', 'messages', 'previousThreads'],
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
  adminChatThreadsResponseSchema,
  adminChatThreadResponseSchema,
  closeChatThreadResponseSchema,
];
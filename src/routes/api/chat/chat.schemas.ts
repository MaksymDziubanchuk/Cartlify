import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const chatThreadExample = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: 1,
  guestId: null,
  type: 'bot',
  status: 'open',
  lastMessageAt: '2026-01-01T10:00:00.000Z',
  unreadCount: 1,
  adminRequestedAt: null,
  adminUnreadSince: null,
  lastMessagePreview: 'Hello, how can I help you?',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
};

const adminChatThreadExample = {
  id: '22222222-2222-4222-8222-222222222222',
  userId: 1,
  guestId: null,
  type: 'admin',
  status: 'open',
  lastMessageAt: '2026-01-01T10:05:00.000Z',
  unreadCount: 1,
  adminRequestedAt: '2026-01-01T10:05:00.000Z',
  adminUnreadSince: null,
  lastMessagePreview: 'I need help with my order.',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:05:00.000Z',
};

const chatMessageExample = {
  id: 1,
  threadId: '11111111-1111-4111-8111-111111111111',
  senderId: 1,
  senderType: 'user',
  content: 'Hello, I need help with my order.',
  isRead: false,
  createdAt: '2026-01-01T10:00:00.000Z',
};

const adminChatMessageExample = {
  id: 2,
  threadId: '22222222-2222-4222-8222-222222222222',
  senderId: 1,
  senderType: 'user',
  content: 'I need help with my order.',
  isRead: false,
  createdAt: '2026-01-01T10:05:00.000Z',
};

const currentChatResponseExample = {
  thread: chatThreadExample,
  messages: [chatMessageExample],
  ws: {
    url: '/api/chat/ws',
    threadId: '11111111-1111-4111-8111-111111111111',
  },
};

const adminChatThreadsQueryExample = {
  page: 1,
  limit: 20,
  queue: 'waiting',
};

const adminChatThreadsResponseExample = {
  items: [adminChatThreadExample],
  page: 1,
  limit: 20,
  total: 1,
};

const chatThreadIdParamsExample = {
  threadId: '22222222-2222-4222-8222-222222222222',
};

const adminChatThreadResponseExample = {
  thread: adminChatThreadExample,
  messages: [adminChatMessageExample],
  previousThreads: [chatThreadExample],
};

const closeChatThreadResponseExample = {
  thread: {
    ...adminChatThreadExample,
    status: 'closed',
    updatedAt: '2026-01-01T10:15:00.000Z',
  },
};

// Schema for current guest or user chat thread
const getCurrentChatSchema = {
  operationId: 'getCurrentChat',
  summary: 'Get current chat',
  description:
    'Returns the current guest or authenticated user chat thread, recent messages and WebSocket connection info.',

  response: {
    200: {
      description: 'Current chat thread was returned successfully.',
      $ref: 'currentChatResponseSchema#',
      examples: [currentChatResponseExample],
    },

    400: {
      description: 'Invalid current chat request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to read current chat.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to read this chat.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading current chat.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin chat queue lookup
const getAdminChatThreadsSchema = {
  operationId: 'getAdminChatThreads',
  summary: 'Get admin chat threads',
  description: 'Returns paginated admin chat queue threads for waiting or active support conversations.',

  querystring: {
    $ref: 'adminChatThreadsQuerySchema#',
    examples: [adminChatThreadsQueryExample],
  },

  response: {
    200: {
      description: 'Admin chat threads were returned successfully.',
      $ref: 'adminChatThreadsResponseSchema#',
      examples: [adminChatThreadsResponseExample],
    },

    400: {
      description: 'Invalid admin chat queue query parameters.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read admin chat threads.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only admin or root users can read admin chat threads.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading admin chat threads.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for single admin chat thread lookup
const getAdminChatThreadSchema = {
  operationId: 'getAdminChatThread',
  summary: 'Get admin chat thread',
  description: 'Returns one admin chat thread with messages and previous related customer threads.',

  params: {
    $ref: 'chatThreadIdParamsSchema#',
    examples: [chatThreadIdParamsExample],
  },

  response: {
    200: {
      description: 'Admin chat thread was returned successfully.',
      $ref: 'adminChatThreadResponseSchema#',
      examples: [adminChatThreadResponseExample],
    },

    400: {
      description: 'Invalid chat thread id.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read admin chat thread.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only admin or root users can read this chat thread.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Chat thread was not found.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading admin chat thread.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for closing admin chat thread
const closeAdminChatThreadSchema = {
  operationId: 'closeAdminChatThread',
  summary: 'Close admin chat thread',
  description: 'Closes an admin support chat thread.',

  params: {
    $ref: 'chatThreadIdParamsSchema#',
    examples: [chatThreadIdParamsExample],
  },

  response: {
    200: {
      description: 'Admin chat thread was closed successfully.',
      $ref: 'closeChatThreadResponseSchema#',
      examples: [closeChatThreadResponseExample],
    },

    400: {
      description: 'Invalid close chat thread request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to close admin chat thread.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only admin or root users can close this chat thread.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Chat thread was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Chat thread state does not allow closing.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while closing admin chat thread.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group chat routes under the chat Swagger tag
const taggedChatSchemas = withOpenApiTag(
  {
    getCurrentChatSchema,
    getAdminChatThreadsSchema,
    getAdminChatThreadSchema,
    closeAdminChatThreadSchema,
  },
  'chat',
);

// Add guest or user cookie security to current chat route
const chatSchemasWithCurrentSecurity = withOpenApiSecurityFor(
  taggedChatSchemas,
  openApiSecurity.userOrGuestCookie,
  ['getCurrentChatSchema'],
);

// Add access token security to admin chat routes
export const chatsSchemas = withOpenApiSecurityFor(
  chatSchemasWithCurrentSecurity,
  openApiSecurity.accessTokenCookie,
  ['getAdminChatThreadsSchema', 'getAdminChatThreadSchema', 'closeAdminChatThreadSchema'],
);
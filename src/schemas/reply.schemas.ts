const paginatedListSchema = {
  $id: 'paginatedList',
  type: 'object',
  properties: {
    total: { type: 'integer' },
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
    items: { type: 'array', items: { type: 'object' } },
  },
  required: ['total', 'page', 'pageSize', 'items'],
} as const;

export const replySchemas = {
  paginatedListSchema,
};

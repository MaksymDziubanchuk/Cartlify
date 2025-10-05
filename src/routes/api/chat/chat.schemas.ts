export const getChatsSchema = {
  querystring: { $ref: 'chatsGetQuerySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const chatsSchemas = {
  getChatsSchema,
};

export const getMeSchema = {
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const patchMeSchema = {
  body: { $ref: 'usersUpdateMeBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const getUserByIdSchema = {
  params: { $ref: 'usersGetByIdParamsSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const usersSchema = {
  getMeSchema,
  patchMeSchema,
  getUserByIdSchema,
};

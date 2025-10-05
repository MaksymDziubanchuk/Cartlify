export const getRootAdminsSchema = {
  querystring: { $ref: 'rootAdminsGetQuerySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const postRootAdminSchema = {
  body: { $ref: 'rootAdminsAddBodySchema#' },
  response: {
    201: { $ref: 'messageResponseSchema#' },
  },
};

export const deleteRootAdminSchema = {
  params: { $ref: 'rootAdminsDeleteParamsSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const rootAdminsSchemas = {
  getRootAdminsSchema,
  postRootAdminSchema,
  deleteRootAdminSchema,
};

export const setLoginSchema = {
  body: { $ref: 'authLoginBodySchema#' },
  response: { 200: { $ref: 'messageResponseSchema#' } },
};

export const setRegisterSchema = {
  body: { $ref: 'authRegisterBodySchema#' },
  response: { 201: { $ref: 'messageResponseSchema#' } },
};

export const setVerifyResendSchema = {
  body: { $ref: 'authResendVerifyBodySchema#' },
  response: { 200: { $ref: 'messageResponseSchema#' } },
};

export const setPasswordForgotSchema = {
  body: { $ref: 'authPasswordForgotBodySchema#' },
  response: { 200: { $ref: 'messageResponseSchema#' } },
};

export const setPasswordResetSchema = {
  querystring: { $ref: 'authPasswordResetQuerySchema#' },
  body: { $ref: 'authPasswordResetBodySchema#' },
  response: { 200: { $ref: 'messageResponseSchema#' } },
};

export const setLogoutSchema = {
  response: { 204: { $ref: 'messageResponseSchema#' } },
};
export const setRefreshSchema = {
  response: { 200: { $ref: 'messageResponseSchema#' } },
};

export const authSchema = {
  setLoginSchema,
  setRegisterSchema,
  setVerifyResendSchema,
  setPasswordForgotSchema,
  setPasswordResetSchema,
  setLogoutSchema,
  setRefreshSchema,
};

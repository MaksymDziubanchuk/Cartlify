export const rootAdminsGetQuerySchema = {
  $id: 'rootAdminsGetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'number', minimum: 1 },
    limit: { type: 'number', minimum: 1 },
    search: { type: 'string' },
  },
} as const;

export const rootAdminsItemSchema = {
  $id: 'rootAdminsItemSchema',
  allOf: [{ $ref: 'usersUserResponseSchema#' }],
} as const;

export const rootAdminsGetResponseSchema = {
  $id: 'rootAdminsGetResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'rootAdminsItemSchema#' } },
    page: { type: 'number' },
    limit: { type: 'number' },
    total: { type: 'number' },
  },
  required: ['items'],
} as const;

export const rootAdminsAddBodySchema = {
  $id: 'rootAdminsAddBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: { type: 'number' },
  },
  required: ['userId'],
} as const;

export const rootAdminsAddResponseSchema = {
  $id: 'rootAdminsAddResponseSchema',
  allOf: [{ $ref: 'usersUserResponseSchema#' }],
} as const;

export const rootAdminsDeleteParamsSchema = {
  $id: 'rootAdminsDeleteParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    adminId: { type: 'number' },
  },
  required: ['adminId'],
} as const;

export const rootAdminsDeleteResponseSchema = {
  $id: 'rootAdminsDeleteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
} as const;

export const rootAdminsDtoSchemas = [
  rootAdminsGetQuerySchema,
  rootAdminsItemSchema,
  rootAdminsGetResponseSchema,
  rootAdminsAddBodySchema,
  rootAdminsAddResponseSchema,
  rootAdminsDeleteParamsSchema,
  rootAdminsDeleteResponseSchema,
];

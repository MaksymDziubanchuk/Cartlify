export const systemHealthResponseSchema = {
    $id: 'SystemHealthResponse',
    description: 'Application health status response',
    type: 'object',
    additionalProperties: false,
    properties: {
        status: {
            type: 'string',
            enum: ['ok', 'error'],
        },
        uptime: {
            type: 'number',
        },
        timestamp: {
            type: 'string',
        },
        env: {
            type: 'string',
            enum: ['development', 'production', 'test'],
        },
        pid: {
            type: 'number',
        },
    },
    required: ['status', 'uptime', 'timestamp', 'env', 'pid'],
} as const;

export const systemReadyOkResponseSchema = {
    $id: 'SystemReadyOkResponse',
    description: 'Application readiness success response',
    type: 'object',
    additionalProperties: false,
    properties: {
        status: {
            type: 'string',
            enum: ['ok'],
        },
        checks: {
            type: 'object',
            additionalProperties: false,
            properties: {
                db: {
                    type: 'string',
                    enum: ['ok'],
                },
                cache: {
                    type: 'string',
                    enum: ['ok'],
                },
            },
            required: ['db', 'cache'],
        },
        timestamp: {
            type: 'string',
        },
    },
    required: ['status', 'checks', 'timestamp'],
} as const;

export const systemReadyErrorResponseSchema = {
    $id: 'SystemReadyErrorResponse',
    description: 'Application readiness error response',
    type: 'object',
    additionalProperties: false,
    properties: {
        status: {
            type: 'string',
            enum: ['error'],
        },
        checks: {
            type: 'object',
            additionalProperties: false,
            properties: {
                db: {
                    type: 'string',
                    enum: ['error', 'ok'],
                },
                cache: {
                    type: 'string',
                    enum: ['error', 'ok'],
                },
            },
            required: ['db', 'cache'],
        },
        timestamp: {
            type: 'string',
        },
    },
    required: ['status', 'checks', 'timestamp'],
} as const;

export const systemInfoResponseSchema = {
    $id: 'SystemInfoResponse',
    description: 'Public project information response',
    type: 'object',
    additionalProperties: false,
    properties: {
        name: {
            type: 'string',
        },
        version: {
            type: 'string',
        },
        env: {
            type: 'string',
            enum: ['development', 'production', 'test'],
        },
    },
    required: ['name', 'version', 'env'],
} as const;

export const systemDtoSchemas = [
    systemHealthResponseSchema,
    systemReadyOkResponseSchema,
    systemReadyErrorResponseSchema,
    systemInfoResponseSchema,
] as const;
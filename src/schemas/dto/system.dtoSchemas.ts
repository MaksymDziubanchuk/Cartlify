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
        redis: {
            type: 'string',
            enum: ['ready', 'down'],
        },
        features: {
            type: 'object',
            additionalProperties: false,
            properties: {
                orderConfirmation: {
                    type: 'string',
                    enum: ['available', 'unavailable'],
                },
                checkout: {
                    type: 'string',
                    enum: ['available', 'unavailable'],
                },
                orderTimeoutQueue: {
                    type: 'string',
                    enum: ['running', 'paused'],
                },
            },
            required: ['orderConfirmation', 'checkout', 'orderTimeoutQueue'],
        },
        orderTimeoutWorker: {
            type: 'object',
            additionalProperties: false,
            description:
                'The pulse of the reservation worker: when its loop last ran (null before the first run) and how many jobs wait in its queues (null while redis is down). A time far behind means the worker stopped.',
            properties: {
                lastRunAt: { type: ['string', 'null'], format: 'date-time' },
                queued: { type: ['integer', 'null'] },
            },
            required: ['lastRunAt', 'queued'],
        },
    },
    required: [
        'status',
        'uptime',
        'timestamp',
        'env',
        'pid',
        'redis',
        'features',
        'orderTimeoutWorker',
    ],
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
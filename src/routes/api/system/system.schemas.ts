import type { FastifySchema } from 'fastify';

import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const systemHealthResponseExample = {
    status: 'ok',
    uptime: 125.42,
    timestamp: '2026-01-01T10:00:00.000Z',
    env: 'development',
    pid: 12345,
};

const systemReadyOkResponseExample = {
    status: 'ok',
    checks: {
        db: 'ok',
        cache: 'ok',
    },
    timestamp: '2026-01-01T10:00:00.000Z',
};

const systemReadyErrorResponseExample = {
    status: 'error',
    checks: {
        db: 'ok',
        cache: 'error',
    },
    timestamp: '2026-01-01T10:00:00.000Z',
};

const systemInfoResponseExample = {
    name: 'cartlify',
    version: '1.0.0',
    env: 'development',
};

// Schema for application health status
const healthSchema = {
    operationId: 'getSystemHealth',
    summary: 'Get application health status',
    description: 'Returns process uptime, current environment and runtime status.',

    response: {
        200: {
            description: 'Application health status was returned successfully.',
            $ref: 'SystemHealthResponse#',
            examples: [systemHealthResponseExample],
        },
    },
} satisfies FastifySchema;

// Schema for application readiness checks
const readySchema = {
    operationId: 'getSystemReadiness',
    summary: 'Get application readiness status',
    description: 'Returns readiness checks for database and cache services required by the application.',

    response: {
        200: {
            description: 'Application is ready to receive traffic.',
            $ref: 'SystemReadyOkResponse#',
            examples: [systemReadyOkResponseExample],
        },

        503: {
            description: 'Application is not ready because at least one dependency check failed.',
            $ref: 'SystemReadyErrorResponse#',
            examples: [systemReadyErrorResponseExample],
        },
    },
} satisfies FastifySchema;

// Schema for public project information
const infoSchema = {
    operationId: 'getSystemInfo',
    summary: 'Get project information',
    description: 'Returns public Cartlify project metadata.',

    response: {
        200: {
            description: 'Project information was returned successfully.',
            $ref: 'SystemInfoResponse#',
            examples: [systemInfoResponseExample],
        },
    },
} satisfies FastifySchema;

// Group system routes under the system Swagger tag
export const systemSchemas = withOpenApiTag(
    {
        healthSchema,
        readySchema,
        infoSchema,
    },
    'system',
);
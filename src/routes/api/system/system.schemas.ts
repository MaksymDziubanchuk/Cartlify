import type { FastifySchema } from 'fastify';

import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const healthSchema = {
    summary: 'Get application health status',
    description: 'Returns process uptime, current environment and runtime status.',

    response: {
        200: {
            $ref: 'SystemHealthResponse#',
        },
    },
} satisfies FastifySchema;

const readySchema = {
    summary: 'Get application readiness status',
    description: 'Returns readiness checks for database and cache services required by the application.',

    response: {
        200: {
            $ref: 'SystemReadyOkResponse#',
        },

        503: {
            $ref: 'SystemReadyErrorResponse#',
        },
    },
} satisfies FastifySchema;

const infoSchema = {
    summary: 'Get project information',
    description: 'Returns public Cartlify project metadata.',

    response: {
        200: {
            $ref: 'SystemInfoResponse#',
        },
    },
} satisfies FastifySchema;

export const systemSchemas = withOpenApiTag(
    {
        healthSchema,
        readySchema,
        infoSchema,
    },
    'system',
);
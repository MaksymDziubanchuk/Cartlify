import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import {
    openApiInfo,
    openApiSecuritySchemes,
    openApiServers,
    openApiTags,
} from '@config/openapi.js';

// Register OpenAPI specification and Swagger UI
const openApiPlugin: FastifyPluginAsync = async (app) => {
    // Register OpenAPI generator before API routes are registered
    await app.register(swagger, {
        openapi: {
            openapi: '3.0.3',

            info: openApiInfo,

            servers: [...openApiServers],

            tags: [...openApiTags],

            components: {
                securitySchemes: openApiSecuritySchemes,
            },
        },
    });

    // Register Swagger UI page
    await app.register(swaggerUi, {
        routePrefix: '/documentation',

        uiConfig: {
            docExpansion: 'list',
            deepLinking: true,
        },
    });
};

// Export as fastify-plugin to avoid plugin encapsulation issues
export default fp(openApiPlugin, {
    name: 'openapi-plugin',
});
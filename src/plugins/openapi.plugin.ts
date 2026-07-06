import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

import { openApiInfo, openApiSecuritySchemes, openApiTags } from '@config/openapi.js';

const openApiPlugin: FastifyPluginAsync = async (app) => {
    await app.register(swagger, {
        openapi: {
            openapi: '3.0.3',

            info: openApiInfo,

            tags: [...openApiTags],

            components: {
                securitySchemes: openApiSecuritySchemes,
            },
        },
    });

    await app.register(swaggerUi, {
        routePrefix: '/documentation',

        uiConfig: {
            docExpansion: 'list',
            deepLinking: true,
        },
    });
};

export default fp(openApiPlugin, {
    name: 'openapi-plugin',
});
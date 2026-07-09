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

const openApiPlugin: FastifyPluginAsync = async (app) => {
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
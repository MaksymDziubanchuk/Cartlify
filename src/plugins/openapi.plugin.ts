import type { FastifyPluginAsync } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { openApiInfo, openApiTags } from '@config/openapi.js';

const openApiPlugin: FastifyPluginAsync = async (app) => {
    await app.register(swagger, {
        openapi: {
            openapi: '3.0.3',

            info: openApiInfo,

            tags: [...openApiTags],

            components: {
                securitySchemes: {
                    accessTokenCookie: {
                        type: 'apiKey',
                        in: 'cookie',
                        name: 'accessToken',
                    },

                    bearerAuth: {
                        type: 'http',
                        scheme: 'bearer',
                        bearerFormat: 'JWT',
                    },
                },
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

export default openApiPlugin;
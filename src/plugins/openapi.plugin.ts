import type { FastifyPluginAsync } from 'fastify';

const openApiPlugin: FastifyPluginAsync = async (_app) => {
    // TODO: register @fastify/swagger
    // TODO: register @fastify/swagger-ui
    // TODO: configure OpenAPI security schemes
    // TODO: expose Swagger UI under /documentation
};

export default openApiPlugin;
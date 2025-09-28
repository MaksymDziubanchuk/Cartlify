import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';

export default async function notFoundHandler(app: FastifyInstance, opt: unknown) {
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(404).send({
      code: 404,
      message: 'Route not found',
      method: req.method,
      url: req.url,
    });
  });
}

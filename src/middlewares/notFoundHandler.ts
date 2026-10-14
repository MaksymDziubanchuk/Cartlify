import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';

export default async function notFoundHandler(app: FastifyInstance) {
  // the same shape as every other api error, ROUTE_NOT_FOUND tells a missing route from a missing record
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(404).send({
      code: 404,
      errorCode: 'ROUTE_NOT_FOUND',
      message: 'Not Found',
      reqId: req.id,
      method: req.method,
      url: req.url,
    });
  });
}

import { AppError } from '@utils/errors.js';
import fastify from 'fastify';
import pino from 'pino';
import getHealthRoute from 'routes/health.js';

const logger: fastify.FastifyBaseLogger = pino(
  {
    level: 'info',
    redact: ['req.headers.authorization', 'request.headers.cookie', "res.headers['set-cookie']"],
  },
  process.env.NODE_ENV === 'development'
    ? pino.transport({
        target: 'pino-pretty',
        options: { translateTime: true },
      })
    : undefined,
);

export const app = fastify({ logger });

app.register(getHealthRoute);

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const statusCode = error instanceof AppError ? error.statusCode : 500;
  return reply.status(statusCode).send({
    code: statusCode,
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : error.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
  });
});

app.setNotFoundHandler((request, reply) => {
  return reply.status(404).send({
    code: 404,
    message: 'Route not found',
    url: request.url,
  });
});

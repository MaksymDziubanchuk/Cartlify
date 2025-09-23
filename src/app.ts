import { AppError } from '@utils/errors.js';
import fastify from 'fastify';
import { LoggerOptions, TransportSingleOptions } from 'pino';
import getHealthRoute from '@routes/health.js';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import staticPlagin from '@fastify/static';
import env from '@config/env.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type LoggerOptionsWithTransport = LoggerOptions & {
  transport?: TransportSingleOptions;
};

const loggerOptions: LoggerOptionsWithTransport = {
  level: 'info',
  redact: ['req.headers.authorization', 'request.headers.cookie', "res.headers['set-cookie']"],
};

if (env.NODE_ENV === 'development') {
  loggerOptions.transport = {
    target: 'pino-pretty',
    options: { translateTime: true },
  };
}

export const app = fastify({ logger: loggerOptions });

app.register(cors, { origin: true, credentials: true });
app.register(helmet);
app.register(cookie, { secret: env.COOKIE_SECRET });
app.register(staticPlagin, { root: path.join(__dirname, 'static') });

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

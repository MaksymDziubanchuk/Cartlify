import { AppError } from '@utils/errors.js';
import fastify from 'fastify';
import { LoggerOptions, TransportSingleOptions } from 'pino';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticPlagin from '@fastify/static';
import multipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import { fileURLToPath } from 'url';
import path from 'path';

import {
  getHealthRouter,
  getProjectInfoRouter,
  getReadyStatusRouter,
} from '@routes/api/system/index.js';
import { authRouter } from '@routes/api/auth/index.js';
import { usersRouter } from '@routes/api/users/index.js';
import { productRouter } from '@routes/api/products/index.js';
import { categoriesRouter } from '@routes/api/categories/index.js';
import env from '@config/env.js';

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
app.register(multipart, {
  limits: {
    fileSize: 10_000_000,
  },
  attachFieldsToBody: true,
});
app.register(formbody, { bodyLimit: 1048576 });
app.register(staticPlagin, { root: path.join(__dirname, 'static'), prefix: '/static/' });

app.register(getHealthRouter, { prefix: '/health' });
app.register(getReadyStatusRouter, { prefix: '/ready' });
app.register(getProjectInfoRouter, { prefix: '/info' });
app.register(authRouter, { prefix: '/auth' });
app.register(usersRouter, { prefix: '/users' });
app.register(productRouter, { prefix: '/products' });
app.register(categoriesRouter, { prefix: '/categories' });

app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

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
    method: request.method,
    url: request.url,
  });
});

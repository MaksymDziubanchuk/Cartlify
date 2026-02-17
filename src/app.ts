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
import env from '@config/env.js';
import { registerRoutes } from '@routes/api/index.js';
import { commonSchemas, paramsSchemas } from '@schemas/index.js';
import { authDtoSchemas } from '@schemas/dto/auth.dtoSchemas.js';
import { adminDtoSchemas } from '@schemas/dto/admin.dtoSchemas.js';
import { productDtoSchemas } from '@schemas/dto/products.dtoSchemas.js';
import { ordersDtoSchemas } from '@schemas/dto/orders.dtoSchemas.js';
import { favoritesDtoSchemas } from '@schemas/dto/favorites.dtoSchemas.js';
import { categoriesDtoSchemas } from '@schemas/dto/categories.dtoSchemas.js';
import { reviewsDtoSchemas } from '@schemas/dto/reviews.dtoSchemas.js';
import { usersDtoSchemas } from '@schemas/dto/users.dtoSchemas.js';
import { rootAdminsDtoSchemas } from '@schemas/dto/root.dtoSchemas.js';
import { chatsDtoSchemas } from '@schemas/dto/chat.dtoSchemas.js';
import requestResponseLogger from '@middlewares/requestResponseLogger.js';
import errorNormalizer from '@middlewares/errorNormalizer.js';
import notFoundHandler from '@middlewares/notFoundHandler.js';

// keep esm __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// allow pino transport type
type LoggerOptionsWithTransport = LoggerOptions & {
  transport?: TransportSingleOptions;
};

// base logger config
const loggerOptions: LoggerOptionsWithTransport = {
  level: 'info',
  // hide sensitive headers
  redact: ['req.headers.authorization', 'request.headers.cookie', "res.headers['set-cookie']"],
};

// dev pretty logs
if (env.NODE_ENV === 'development') {
  loggerOptions.transport = {
    // pretty log options
    target: 'pino-pretty',
    options: { singleLine: true },
  };
}

// create fastify instance
// enable ajv coercion
export const app = fastify({
  logger: loggerOptions,
  // coerce query/body types
  ajv: { customOptions: { coerceTypes: true } },
});

// add request/response logs
app.register(requestResponseLogger);

// add security headers
app.register(cors, { origin: true, credentials: true });
app.register(helmet);

// cookie secret for signing
// enable signed cookies later
app.register(cookie, { secret: env.COOKIE_SECRET });
app.register(multipart, {
  // file upload limits
  limits: {
    fileSize: 10_000_000,
  },
  // expose fields in body
  attachFieldsToBody: false,
});

// parse x-www-form-urlencoded
app.register(formbody, { bodyLimit: 1048576 });

// serve static assets
app.register(staticPlagin, { root: path.join(process.cwd(), 'src', 'static'), prefix: '/static/' });
app.register(rateLimit, {
  // protect from abuse
  max: 100,
  timeWindow: '1 minute',
  allowList: (req) =>
    // allow health and static
    req.url?.startsWith('/health') ||
    req.url?.startsWith('/ready') ||
    req.url?.startsWith('/static'),
});

// register shared schemas
for (const schema of [
  ...commonSchemas,
  // register dto schemas
  ...paramsSchemas,
  ...authDtoSchemas,
  ...productDtoSchemas,
  ...adminDtoSchemas,
  ...ordersDtoSchemas,
  ...favoritesDtoSchemas,
  ...categoriesDtoSchemas,
  ...reviewsDtoSchemas,
  ...usersDtoSchemas,
  ...rootAdminsDtoSchemas,
  ...chatsDtoSchemas,
]) {
  // add schemas to ajv
  app.addSchema(schema);
}

// normalize errors to json
errorNormalizer(app);

// register api routes
await registerRoutes(app);

// final 404 handler
app.register(notFoundHandler);

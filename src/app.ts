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

export const app = fastify({
  logger: loggerOptions,
  ajv: { customOptions: { coerceTypes: true } },
});

app.register(requestResponseLogger);
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
app.register(staticPlagin, { root: path.join(process.cwd(), 'src', 'static'), prefix: '/static/' });
app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  allowList: (req) =>
    req.url?.startsWith('/health') ||
    req.url?.startsWith('/ready') ||
    req.url?.startsWith('/static'),
});

for (const schema of [
  ...commonSchemas,
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
  app.addSchema(schema);
}

errorNormalizer(app);

await registerRoutes(app);
app.register(notFoundHandler);

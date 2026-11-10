import fastify, { LogController } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { fastifyCookie } from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import env from '@config/env.js';
import { loggerOptions } from '@config/logger.js';
import { allowedWebOrigins } from '@helpers/webOrigin.js';
import { registerRoutes } from '@routes/api/index.js';
import { isRateLimitFree } from '@helpers/rateLimitFree.js';
import { commonSchemas, paramsSchemas } from '@schemas/index.js';
import { authDtoSchemas } from '@schemas/dto/auth.dtoSchemas.js';
import { adminDtoSchemas } from '@schemas/dto/admin.dtoSchemas.js';
import { productDtoSchemas } from '@schemas/dto/products.dtoSchemas.js';
import { variantDtoSchemas } from '@schemas/dto/variants.dtoSchemas.js';
import { ordersDtoSchemas } from '@schemas/dto/orders.dtoSchemas.js';
import { favoritesDtoSchemas } from '@schemas/dto/favorites.dtoSchemas.js';
import { categoriesDtoSchemas } from '@schemas/dto/categories.dtoSchemas.js';
import { partiesDtoSchemas } from '@schemas/dto/parties.dtoSchemas.js';
import { returnsDtoSchemas } from '@schemas/dto/returns.dtoSchemas.js';
import { withdrawalsDtoSchemas } from '@schemas/dto/withdrawals.dtoSchemas.js';
import { documentsDtoSchemas } from '@schemas/dto/documents.dtoSchemas.js';
import { attributesDtoSchemas } from '@schemas/dto/attributes.dtoSchemas.js';
import { reviewsDtoSchemas } from '@schemas/dto/reviews.dtoSchemas.js';
import { usersDtoSchemas } from '@schemas/dto/users.dtoSchemas.js';
import { rootAdminsDtoSchemas } from '@schemas/dto/root.dtoSchemas.js';
import { chatsDtoSchemas } from '@schemas/dto/chat.dtoSchemas.js';
import { paymentDtoSchemas } from '@schemas/dto/payment.dtoSchema.js';
import { systemDtoSchemas } from '@schemas/dto/system.dtoSchemas.js';
import { legalDtoSchemas } from '@schemas/dto/legal.dtoSchemas.js';
import { deliveryDtoSchemas } from '@schemas/dto/delivery.dtoSchemas.js';
import { shopSettingsDtoSchemas } from '@schemas/dto/shopSettings.dtoSchemas.js';
import { newslettersDtoSchemas } from '@schemas/dto/newsletters.dtoSchemas.js';
import { newslettersAdminDtoSchemas } from '@schemas/dto/newslettersAdmin.dtoSchemas.js';
import { newslettersCampaignDtoSchemas } from '@schemas/dto/newslettersCampaign.dtoSchemas.js';
import requestResponseLogger from '@middlewares/requestResponseLogger.js';
import errorNormalizer from '@middlewares/errorNormalizer.js';
import { holdsNul } from '@helpers/nulText.js';
import { requestContext, requestContextOf } from '@helpers/requestContext.js';
import { BadRequestError } from '@utils/errors.js';
import openApiPlugin from './plugins/openapi.plugin.js';
import csrfPlugin from './plugins/csrf.plugin.js';
import notFoundHandler from '@middlewares/notFoundHandler.js';
import { FORM_BODY_LIMIT_BYTES, MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';

// create fastify instance
// enable ajv coercion
export const app = fastify({
  logger: loggerOptions(),

  // disable fastify built-in request logs (incoming/completed); fastify 5.12 moved the option
  // into the log controller, the top-level one is deprecated
  logController: new LogController({ disableRequestLogging: true }),

  // coerce query/body types; multipleOf of money (0.01) is checked to 8 places, without it a
  // price like 10.01 divides by 0.01 into 1000.9999999999999 and is refused
  ajv: { customOptions: { coerceTypes: true, multipleOfPrecision: 8 } },

  // behind the proxy of the host: the address of a client is the one the proxy names
  // (x-forwarded-for), not the address of the proxy, so the limits count each client. The first
  // TRUST_PROXY_HOPS hops are trusted (hop 0 is the connection itself); the left part of the
  // header is written by the client, it is never trusted further
  trustProxy: (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS,
});

// the address and the browser of each request go with the work done for it, the admin log keeps
// them (src/helpers/requestContext.ts): the rest of the request runs inside its context
app.addHook('onRequest', (req, _reply, done) => {
  requestContext.run(requestContextOf(req), done);
});

// LOG_REQUEST_ADDRESSES=true: the addresses of each request, to check on a new host how many
// proxies stand in front of the server (req.ips lists them); off in normal work
if (env.LOG_REQUEST_ADDRESSES) {
  app.addHook('onRequest', async (req) => {
    req.log.info({ ip: req.ip, ips: req.ips }, 'request addresses');
  });
}

// a NUL sign is no text postgres keeps: a json body that holds one in a text failed with 500 at
// the database. It is refused before any route with 400 TEXT_NUL_FORBIDDEN; the rest is the
// default parser of fastify, with its protection of prototypes (the stripe webhook keeps its own)
const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  defaultJsonParser(req, body as string, (err, parsed) => {
    if (err) return done(err, undefined);
    if (holdsNul(parsed)) return done(new BadRequestError('TEXT_NUL_FORBIDDEN'), undefined);
    done(null, parsed);
  });
});

// add request/response logs
app.register(requestResponseLogger);

// add security headers
// only the frontend from WEB_ORIGIN may read answers and send cookies cross-origin. Without the
// methods the preflight allows only GET, HEAD and POST, and the browser refuses every PUT, PATCH
// and DELETE; the page reads the file name of a csv report and the wait after 429 itself
app.register(cors, {
  origin: allowedWebOrigins,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  exposedHeaders: ['content-disposition', 'retry-after'],
});
app.register(helmet);

// parse cookies
app.register(fastifyCookie);

// check the csrf token of requests that change data, needs the cookies parsed
app.register(csrfPlugin);

app.register(multipart, {
  // file upload limits
  limits: {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
  },
  // expose fields in body
  attachFieldsToBody: false,
});

// parse x-www-form-urlencoded
app.register(formbody, { bodyLimit: FORM_BODY_LIMIT_BYTES });

app.register(rateLimit, {
  // protect from abuse: the requests a minute one address may make
  max: env.RATE_LIMIT_MAX,
  timeWindow: '1 minute',
  // health checks and the events of payment providers are not counted
  allowList: (req) => isRateLimitFree(req.url ?? ''),
});

// register shared schemas
for (const schema of [
  ...commonSchemas,
  // register dto schemas
  ...paramsSchemas,
  ...systemDtoSchemas,
  ...authDtoSchemas,
  ...variantDtoSchemas,
  ...productDtoSchemas,
  ...adminDtoSchemas,
  ...ordersDtoSchemas,
  ...favoritesDtoSchemas,
  ...categoriesDtoSchemas,
  ...partiesDtoSchemas,
  ...returnsDtoSchemas,
  ...withdrawalsDtoSchemas,
  ...documentsDtoSchemas,
  ...attributesDtoSchemas,
  ...reviewsDtoSchemas,
  ...usersDtoSchemas,
  ...rootAdminsDtoSchemas,
  ...chatsDtoSchemas,
  ...paymentDtoSchemas,
  ...legalDtoSchemas,
  ...deliveryDtoSchemas,
  ...shopSettingsDtoSchemas,
  ...newslettersDtoSchemas,
  ...newslettersAdminDtoSchemas,
  ...newslettersCampaignDtoSchemas,
]) {
  // add schemas to ajv
  app.addSchema(schema);
}

// register OpenAPI docs before API routes
await app.register(openApiPlugin);

// normalize errors to json
errorNormalizer(app);

// ws gathers a frame in memory before the app reads it (100 MB unless told): a bigger one closes the
// socket with 1009; the chat takes messages up to 8000 characters (chatWs.parser.ts)
await app.register(websocket, {
  options: { maxPayload: 16_384 },
  // a frame the client broke (too big, not utf-8, a wrong opcode): ws closes the socket itself with
  // the code of the fault, it is traffic of the client and no failure of the server
  errorHandler: (error, socket, request) => {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('WS_ERR_')) {
      request.log.info({ code }, 'chat socket closed for a broken frame');
      return;
    }

    request.log.error({ err: error }, 'chat socket failed');
    socket.terminate();
  },
});

// register api routes
await registerRoutes(app);

// final 404 handler
app.register(notFoundHandler);

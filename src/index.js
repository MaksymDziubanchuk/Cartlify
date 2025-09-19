const fastify = require('fastify');

const app = fastify({
  logger: {
    level: 'info',
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { translateTime: true } }
        : undefined,
    redact: ['req.headers.authorization', 'request.headers.cookie', "res.headers['set-cookie']"],
  },
});

app.register(require('@fastify/cookie'), {
  secret: process.env.COOKIE_SECRET || 'dev-only-change-me',
  hook: 'onRequest',
});

app.addHook('onRequest', async (req, reply) => {
  req.startTs = Date.now();
});

app.addHook('onSend', async (req, reply, payload) => {
  reply.header('X-Response-Time', Date.now() - req.startTs + 'ms');
  return payload;
});

app.setErrorHandler((err, req, reply) => {
  req.log.error({ err }, 'unhandled error');

  if (err.validation) {
    return reply.code(400).send({
      status: 'error',
      message: 'Validation failed',
      details: err.validation,
    });
  }

  reply.code(500).send({ status: 'error', message: 'Internal Server Error' });
});

app.setNotFoundHandler((req, reply) => {
  reply.code(404).send({ status: 'error', message: 'Not Found' });
});

app.get('/ping', async () => ({ ok: true, ts: Date.now() }));

app.post('/echo', async (req, reply) => {
  return reply.code(200).send({
    method: req.method,
    query: req.query,
    params: req.params,
    body: req.body,
  });
});

app.post('/set-cookie', async (req, reply) => {
  reply.setCookie('anonCartId', 'cart_123', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
    signed: true,
  });
  return reply.code(200).send();
});

app.get('/whoami', async (req, reply) => {
  const parsed = req.unsignCookie(req.cookies.anonCartId || '');
  return reply.send({
    anonCartId: parsed.valid ? parsed.value : null,
    signedValid: parsed.valid,
  });
});

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(`Server running at http://${HOST}:${PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, async () => {
    app.log.info(`Received ${sig}, shutting down...`);
    await app.close();
    process.exit(0);
  });
});

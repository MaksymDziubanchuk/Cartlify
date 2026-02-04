import { FastifyRequest, FastifyReply, HookHandlerDoneFunction, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import env from '@config/env.js';

async function requestResponseLogger(app: FastifyInstance, opt: unknown) {
  // track request start time
  app.addHook(
    'onRequest',
    (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
      // store timestamp on request
      req.startTime = Date.now();

      done();
    },
  );
  // log request after response
  app.addHook(
    'onResponse',
    (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
      // compute response duration
      const responseTime = Date.now() - (req.startTime as number);
      const timestamp = new Date().toISOString();
      // include current auth identity
      const role = req.user?.role ?? 'ANON';
      const userId = req.user?.id ?? 'unknown';

      // dev: human readable log
      if (env.NODE_ENV === 'development') {
        req.log.info(
          `[${timestamp}] ${req.method} ${req.url} ${reply.statusCode} ${role}(id=${userId}) - ${responseTime}ms`,
        );
        // prod: structured json log
      } else {
        req.log.info({
          reqId: req.id,
          timestamp,
          method: req.method,
          url: req.url,
          statusCode: reply.statusCode,
          // attach user fields for search
          userId: req.user?.id,
          role: req.user?.role,
          responseTime,
        });
      }
      done();
    },
  );
}

export default fp(requestResponseLogger);

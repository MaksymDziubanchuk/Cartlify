import { FastifyRequest, FastifyReply, HookHandlerDoneFunction, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import env from '@config/env.js';

async function requestResponseLogger(app: FastifyInstance, opt: unknown) {
  app.addHook(
    'onRequest',
    (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
      req.startTime = Date.now();

      done();
    },
  );
  app.addHook(
    'onResponse',
    (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
      const responseTime = Date.now() - (req.startTime as number);
      const timestamp = new Date().toISOString();
      const role = req.user?.role ?? 'ANON';
      const userId = req.user?.id ?? 'unknown';

      if (env.NODE_ENV === 'development') {
        req.log.info(
          `[${timestamp}] ${req.method} ${req.url} ${reply.statusCode} ${role}(id=${userId}) - ${responseTime}ms`,
        );
      } else {
        req.log.info({
          reqId: req.id,
          timestamp,
          method: req.method,
          url: req.url,
          statusCode: reply.statusCode,
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

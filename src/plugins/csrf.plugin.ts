import fastifyCsrf from '@fastify/csrf-protection';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import env from '@config/env.js';

const isProd = env.NODE_ENV === 'production';

// the page sends the token back in this header with every request that changes data
export const CSRF_HEADER = 'x-csrf-token';

// __Host- keeps a sibling subdomain from planting a secret of its own; it needs a secure cookie
export const CSRF_COOKIE = isProd ? '__Host-csrf' : 'csrf';

// methods that change data; GET, HEAD and OPTIONS only read
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// one rule for the check and for the docs: a request that changes data needs the token,
// unless its route opts out with config.csrf: false (the stripe webhook signs its own calls)
export function requiresCsrfToken(method: string, config?: { csrf?: boolean }): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase()) && config?.csrf !== false;
}

// double-submit protection: GET /api/auth/csrf puts a secret into an httpOnly cookie and gives
// the page a token made from it, a request that changes data has to bring that token back.
// A foreign page cannot get a token: cors lets only WEB_ORIGIN read our answers
const csrfPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyCsrf, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: CSRF_COOKIE,
    cookieOpts: { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/' },
    // the header only: a field in the body would need the body parsed before the check
    getToken: (req) => req.headers[CSRF_HEADER] as string | undefined,
    // errorNormalizer logs the refusal itself
    logLevel: 'debug',
  });

  // onRequest: a refused request is stopped before its body is read;
  // an unknown route keeps its 404
  app.addHook('onRequest', (req, reply, done) => {
    if (req.is404 || !requiresCsrfToken(req.method, req.routeOptions.config)) return done();

    app.csrfProtection(req, reply, done);
  });
};

// Export as fastify-plugin so the hook covers every route registered after it
export default fp(csrfPlugin, {
  name: 'csrf-plugin',
});

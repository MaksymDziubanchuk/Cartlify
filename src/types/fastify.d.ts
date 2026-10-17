import 'fastify';
import type { User } from './user.ts';

// extend fastify request fields
declare module 'fastify' {
  interface FastifyContextConfig {
    rawBody?: boolean;
    // false lets a route that changes data skip the csrf token check
    csrf?: boolean;
    // documentation only: id of the schema of a multipart form the route takes besides its
    // json body; the swagger lists both, validation keeps the json schema of the route
    formBodySchema?: string;
  }

  interface FastifyRequest {
    user?: User;
    startTime?: number;
    rawBody?: string | Buffer;
    // the refresh token the guard issued in this request when it renewed the session;
    // the one in the cookie is spent then
    issuedRefreshToken?: string;
  }
}

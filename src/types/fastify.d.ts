import 'fastify';
import type { User } from './user.ts';

// extend fastify request fields
declare module 'fastify' {
  interface FastifyContextConfig {
    rawBody?: boolean;
    // false lets a route that changes data skip the csrf token check
    csrf?: boolean;
  }

  interface FastifyRequest {
    user?: User;
    startTime?: number;
    rawBody?: string | Buffer;
  }
}

import 'fastify';
import type { User } from './user.ts';

// extend fastify request fields
declare module 'fastify' {
  interface FastifyContextConfig {
    rawBody?: boolean;
  }

  interface FastifyRequest {
    user?: User;
    startTime?: number;
    rawBody?: string | Buffer;
  }
}

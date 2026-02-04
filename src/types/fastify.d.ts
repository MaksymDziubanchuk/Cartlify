import 'fastify';
import type { User } from './user.ts';

// extend fastify request fields
declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    startTime?: number;
  }
}

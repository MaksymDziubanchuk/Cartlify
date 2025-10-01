import 'fastify';
import type { User } from './user.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    startTime?: number;
  }
}

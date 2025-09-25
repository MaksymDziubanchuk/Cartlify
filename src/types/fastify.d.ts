import 'fastify';
import { User } from './user.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

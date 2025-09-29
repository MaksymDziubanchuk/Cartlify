import { FastifyRequest } from 'fastify';

export type RequestParams<T> = FastifyRequest<{ Params: T }>;
export type RequestBody<T> = FastifyRequest<{ Body: T }>;
export type RequestQuery<T> = FastifyRequest<{ Querystring: T }>;
export type RequestReply<T> = FastifyRequest<{ Reply: T }>;
export type RequestFull<P, B, Q, R> = FastifyRequest<{
  Params: P;
  Body: B;
  Querystring: Q;
  Reply: R;
}>;

import { RouteHandler, RouteGenericInterface } from 'fastify';

interface ControllerRouteGeneric<P, B, Q, R> extends RouteGenericInterface {
  Params: P;
  Body: B;
  Querystring: Q;
  Reply: R;
}

export type ControllerRouter<P = unknown, B = unknown, Q = unknown, R = unknown> = RouteHandler<
  ControllerRouteGeneric<P, B, Q, R>
>;

import { RouteHandler, RouteGenericInterface } from 'fastify';

// map dto types to fastify generics
interface ControllerRouteGeneric<P, B, Q, R> extends RouteGenericInterface {
  Params: P;
  Body: B;
  Querystring: Q;
  Reply: R;
}

// typed handler alias for routes
export type ControllerRouter<P = unknown, B = unknown, Q = unknown, R = unknown> = RouteHandler<
  ControllerRouteGeneric<P, B, Q, R>
>;

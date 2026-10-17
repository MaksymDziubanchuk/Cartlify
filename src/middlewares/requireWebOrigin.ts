import type { FastifyRequest } from 'fastify';
import { ForbiddenError } from '@utils/errors.js';
import { isAllowedWebOrigin } from '@helpers/webOrigin.js';

// any page can open a websocket to us and the browser sends the visitor's cookies with it,
// CORS does not apply to the handshake, so a handshake from a foreign page is refused here.
// A browser always sends Origin; a client without one is not a page in someone's browser,
// it has no victim's cookies to ride on
export default async function requireWebOrigin(req: FastifyRequest) {
  const origin = req.headers.origin;

  if (origin === undefined || isAllowedWebOrigin(origin)) return;

  throw new ForbiddenError('ORIGIN_NOT_ALLOWED');
}

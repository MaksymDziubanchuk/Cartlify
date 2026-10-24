import { AsyncLocalStorage } from 'node:async_hooks';

// the request the work of the server is done for: its address (the one the proxy names, see
// trustProxy in app.ts) and its browser. The admin log keeps them with each line, the lines the
// functions of the database write too (cartlify.log_admin_action reads them from the context of
// the transaction, set*Context in db/dbContext.service.ts). A job without a request (the worker)
// has none

export type RequestContext = { ip: string | null; userAgent: string | null };

// the longest browser kept, the way a session keeps it
const USER_AGENT_MAX_LENGTH = 500;

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const currentRequest = (): RequestContext | null => requestContext.getStore() ?? null;

export const requestContextOf = (req: {
  ip?: string;
  headers: Record<string, unknown>;
}): RequestContext => {
  const agent = req.headers['user-agent'];
  return {
    ip: req.ip || null,
    userAgent:
      typeof agent === 'string' ? agent.trim().slice(0, USER_AGENT_MAX_LENGTH) || null : null,
  };
};

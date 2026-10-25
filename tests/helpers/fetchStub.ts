import { jest } from '@jest/globals';

export type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  // the signal of the call, an answer that waits for it ends the way an aborted request ends
  signal?: AbortSignal;
  redirect?: RequestRedirect;
};

// replace the global fetch for one test; every call is recorded, the handler gives the answer
export function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];

  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call: FetchCall = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body == null ? '' : String(init.body),
      ...(init?.signal ? { signal: init.signal } : {}),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    };

    calls.push(call);
    return handler(call);
  });

  return calls;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

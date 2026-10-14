import type { FastifyReply, FastifyRequest } from 'fastify';

export type RecordedCookie = { value: string; options: Record<string, unknown> };

// a reply that records cookies and headers, for unit tests of code that only sets them
export function fakeReply() {
  const cookies: Record<string, RecordedCookie> = {};
  const cleared: string[] = [];
  const headers: Record<string, string> = {};

  const reply = {
    setCookie(name: string, value: string, options: Record<string, unknown>) {
      cookies[name] = { value, options };
      return reply;
    },
    clearCookie(name: string) {
      cleared.push(name);
      return reply;
    },
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
  };

  return { reply: reply as unknown as FastifyReply, cookies, cleared, headers };
}

// a request with the given url, cookies and route params
export function fakeRequest(
  args: { url?: string; cookies?: Record<string, string>; params?: Record<string, unknown> } = {},
) {
  return {
    url: args.url ?? '/api/products',
    cookies: args.cookies ?? {},
    params: args.params ?? {},
  } as unknown as FastifyRequest;
}

import env from '@config/env.js';
import { toOrigin } from '@helpers/webOrigin.js';

// API address of the tests when API_ORIGIN is not set; it differs from the frontend one, so a test
// sees a link that went to the wrong one of the two
const DEV_API_ORIGIN = 'http://localhost:4000';

function resolveApiOrigin(): string {
  const raw = env.API_ORIGIN.trim();

  // the start stops without API_ORIGIN in development as in production (src/config/env.ts); only the
  // tests may go without and fall back to localhost
  if (!raw) return DEV_API_ORIGIN;

  const origin = toOrigin(raw);
  if (!origin) {
    throw new Error('Invalid env variable: API_ORIGIN must be an http or https address');
  }

  // a mail client posts the one-click unsubscribe (RFC 8058) to an https address only
  if (env.NODE_ENV === 'production' && !origin.startsWith('https://')) {
    throw new Error('Invalid env variable: API_ORIGIN must be an https address in production');
  }

  return origin;
}

// the address the API is reached on from outside (scheme, host and port)
export const apiOrigin: string = resolveApiOrigin();

// an address on the API, for a header or a link a mail client or a person opens outside the app. The
// path is taken as a path of the API, so a path that starts with two slashes cannot lead to another
// host
export function apiUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`/${path.replace(/^\/+/, '')}`, apiOrigin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  return url.toString();
}

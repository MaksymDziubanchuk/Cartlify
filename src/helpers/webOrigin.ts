import env from '@config/env.js';
import { InternalError } from '@utils/errors.js';

// frontend address outside production when WEB_ORIGIN is not set
const DEV_WEB_ORIGIN = 'http://localhost:3000';

// scheme, host and port of an address, the form a browser puts in the Origin header
// (no path, no trailing slash, no default port); null when it is not an http or https address
export function toOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    return url.origin;
  } catch {
    return null;
  }
}

function resolveWebOrigin(): string | null {
  const raw = env.WEB_ORIGIN.trim();

  // production without WEB_ORIGIN has no frontend, development falls back to localhost
  if (!raw) return env.NODE_ENV === 'production' ? null : DEV_WEB_ORIGIN;

  const origin = toOrigin(raw);
  if (!origin) {
    throw new Error('Invalid env variable: WEB_ORIGIN must be an http or https address');
  }

  return origin;
}

// the frontend, null in production when WEB_ORIGIN is not set
export const webOrigin: string | null = resolveWebOrigin();

// sites whose pages may call the api with the visitor's cookies
export const allowedWebOrigins: string[] = webOrigin ? [webOrigin] : [];

// the check is exact: a browser sends the origin normalized, so no trimming or case folding here
export function isAllowedWebOrigin(origin: string): boolean {
  return allowedWebOrigins.includes(origin);
}

// address of a frontend page, for mail links and redirects back to the site;
// a production server without WEB_ORIGIN cannot build one
export function webUrl(path: string, params: Record<string, string> = {}): string {
  if (!webOrigin) throw new InternalError({ reason: 'WEB_ORIGIN_REQUIRED' });

  const url = new URL(path, webOrigin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  return url.toString();
}

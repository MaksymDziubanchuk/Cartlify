import { AppError } from '@utils/errors.js';

// how long the login waits for an oauth provider: the person waits with the browser on our callback
export const OAUTH_PROVIDER_TIMEOUT_MS = 5_000;

export type ProviderAnswer = { ok: boolean; status: number; text: string };

const isAbort = (err: unknown) => err instanceof Error && err.name === 'AbortError';

// a request to an oauth provider (the code exchange, the profile, the keys): the status and the
// whole text of its answer within 5 seconds. A provider out of reach or silent that long is
// 503 OAUTH_PROVIDER_UNAVAILABLE: the login page tells the person to try again
export async function fetchFromProvider(url: string, init: RequestInit): Promise<ProviderAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_PROVIDER_TIMEOUT_MS);

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });

    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (err) {
    throw new AppError({
      statusCode: 503,
      errorCode: 'OAUTH_PROVIDER_UNAVAILABLE',
      message: 'Service Unavailable',
      // for the log only: which provider and why, never the request with its secrets
      details: { host: new URL(url).host, reason: isAbort(err) ? 'timeout' : 'network' },
      expose: false,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

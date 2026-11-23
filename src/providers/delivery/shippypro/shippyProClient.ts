import env from '@config/env.js';
import { AppError, ConflictError, InternalError, ServiceUnavailableError } from '@utils/errors.js';

import {
  DELIVERY_PARCEL_REFUSED,
  DELIVERY_PROVIDER_NOT_CONFIGURED,
  DELIVERY_PROVIDER_UNAVAILABLE,
} from '../types.js';

// The requests to ShippyPro, their time limits and the way a silence becomes our error.
// v1: every method is POST /v1/<Method> with the body {"Method", "Params"}; v2: a REST api of the
// catalog of the carriers. Both sign with the key as a bearer token. ShippyPro answers an error of
// a request with 200 as well: the callers read the body (Status, Error, RatesErrors)

const SHIPPYPRO_API = 'https://api.shippypro.com';

// how long ShippyPro may take: the prices (the buyer waits at the cart), the creation of a parcel
// (the carrier makes the label while the request is open) and every other request
export const SHIPPYPRO_TIMEOUTS_MS = { rates: 8000, ship: 20_000, other: 10_000 } as const;

export type ShippyProBody = Record<string, unknown>;

const keyOf = (): string => env.SHIPPYPRO_API_KEY.trim();

export const shippyProConfigured = (): boolean => keyOf() !== '';

const unavailable = (cause: unknown): ServiceUnavailableError =>
  new ServiceUnavailableError(DELIVERY_PROVIDER_UNAVAILABLE, undefined, cause);

// one request; a status that is no success (429 for a limit, 401 for the key, 5xx), no answer in
// time, no answer at all or one that is no json object is DELIVERY_PROVIDER_UNAVAILABLE, with the
// request and the status in the cause (never the key, never the answer: it may repeat the recipient)
async function request(path: string, init: RequestInit, timeoutMs: number): Promise<ShippyProBody> {
  const key = keyOf();
  if (!key) throw new InternalError({ reason: DELIVERY_PROVIDER_NOT_CONFIGURED });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${SHIPPYPRO_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: controller.signal,
    });

    const raw = await res.text();
    // the cause names the request and the status only: the body may repeat the recipient
    if (!res.ok) throw unavailable({ path, status: res.status });

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw unavailable({ path, status: res.status, reason: 'not_json' });
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw unavailable({ path, status: res.status, reason: 'not_an_object' });
    }

    return body as ShippyProBody;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unavailable({ path, error: err instanceof Error ? err.name : String(err) });
  } finally {
    clearTimeout(timeout);
  }
}

// a method of v1. An answer that is an error of the request as a whole ({"Error": "..."}: a feature
// the account has not, a request it could not read) is DELIVERY_PROVIDER_UNAVAILABLE too, but the
// errors the caller names as the words of a carrier (refusal), a refusal of the carrier
// (DELIVERY_PARCEL_REFUSED with them)
export async function callShippyPro(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = SHIPPYPRO_TIMEOUTS_MS.other,
  refusal?: RegExp,
): Promise<ShippyProBody> {
  const body = await request(
    `/v1/${method}`,
    { method: 'POST', body: JSON.stringify({ Method: method, Params: params }) },
    timeoutMs,
  );

  if (typeof body.Error === 'string' && body.Error) {
    if (refusal?.test(body.Error)) {
      throw new ConflictError(DELIVERY_PARCEL_REFUSED, { message: body.Error.slice(0, 500) });
    }
    throw unavailable({ method, reason: 'error_answer' });
  }

  return body;
}

// a read of v2 (the catalog of the carriers and what each can do)
export function getShippyPro(path: string): Promise<ShippyProBody> {
  return request(path, { method: 'GET' }, SHIPPYPRO_TIMEOUTS_MS.other);
}

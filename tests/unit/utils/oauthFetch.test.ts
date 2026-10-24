import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { fetchFromProvider, OAUTH_PROVIDER_TIMEOUT_MS } from '@utils/oauthFetch.js';

import { rejectedBy } from '../../helpers/errors.js';
import { stubFetch } from '../../helpers/fetchStub.js';

const URL_OF_TOKENS = 'https://oauth2.googleapis.com/token';

// an abort the way fetch reports it
const abortError = () =>
  Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('fetchFromProvider', () => {
  it('gives the status and the text of the answer, and passes the request on', async () => {
    const calls = stubFetch(() => new Response('{"ok":true}', { status: 201 }));

    const answer = await fetchFromProvider(URL_OF_TOKENS, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'code=abc',
    });

    expect(answer).toEqual({ ok: true, status: 201, text: '{"ok":true}' });
    expect(calls[0]).toMatchObject({
      url: URL_OF_TOKENS,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'code=abc',
      signal: expect.any(AbortSignal),
    });
  });

  it('gives an answer of a refusal as it is, for the caller to read', async () => {
    stubFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 }));

    expect(await fetchFromProvider(URL_OF_TOKENS, { method: 'POST' })).toEqual({
      ok: false,
      status: 400,
      text: '{"error":"invalid_grant"}',
    });
  });

  it('waits 5 seconds at most', () => {
    expect(OAUTH_PROVIDER_TIMEOUT_MS).toBe(5_000);
  });

  // a provider that never answers kept the browser of the person waiting with nothing to show
  it('gives up on a provider silent for 5 seconds with 503 OAUTH_PROVIDER_UNAVAILABLE', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()));
        }),
    );

    let settled = false;
    const pending = fetchFromProvider(URL_OF_TOKENS, { method: 'POST' }).finally(() => {
      settled = true;
    });
    pending.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(await rejectedBy(() => pending)).toMatchObject({
      statusCode: 503,
      errorCode: 'OAUTH_PROVIDER_UNAVAILABLE',
      details: { host: 'oauth2.googleapis.com', reason: 'timeout' },
      expose: false,
    });
  });

  it('gives up the same way on an answer whose body stops coming', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(abortError()));
        },
      });
      return new Response(body, { status: 200 });
    });

    const pending = fetchFromProvider(URL_OF_TOKENS, { method: 'POST' });
    pending.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(OAUTH_PROVIDER_TIMEOUT_MS);
    expect(await rejectedBy(() => pending)).toMatchObject({
      errorCode: 'OAUTH_PROVIDER_UNAVAILABLE',
      details: { reason: 'timeout' },
    });
  });

  it('refuses a provider out of reach with 503 OAUTH_PROVIDER_UNAVAILABLE', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    expect(await rejectedBy(() => fetchFromProvider(URL_OF_TOKENS, {}))).toMatchObject({
      statusCode: 503,
      errorCode: 'OAUTH_PROVIDER_UNAVAILABLE',
      details: { host: 'oauth2.googleapis.com', reason: 'network' },
    });
  });

  it('leaves no timer behind after an answer', async () => {
    jest.useFakeTimers();
    stubFetch(() => new Response('ok'));

    await fetchFromProvider(URL_OF_TOKENS, {});

    expect(jest.getTimerCount()).toBe(0);
  });
});

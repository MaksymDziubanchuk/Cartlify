import { afterEach, describe, expect, it, jest } from '@jest/globals';

import env from '@config/env.js';
import {
  TURNSTILE_SITEVERIFY_URL,
  TURNSTILE_TIMEOUT_MS,
  verifyCaptcha,
} from '@services/captcha/turnstile.service.js';

import { rejectedBy } from '../../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../../helpers/fetchStub.js';

// The check of the captcha of Cloudflare Turnstile: siteverify says whether the answer the widget
// gave the visitor is good. A visitor who failed it is refused (400 CAPTCHA_INVALID); a Cloudflare
// that cannot say, or a secret it does not know, refuses the request too (503 CAPTCHA_UNAVAILABLE):
// an outage of Cloudflare must not let every request through

const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX-the-answer-of-the-widget';
const IP = '203.0.113.7';

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const logger = () => ({ warn: jest.fn() });

const passes = () =>
  jsonResponse({
    success: true,
    'error-codes': [],
    challenge_ts: '2026-11-08T22:54:36.270Z',
    hostname: 'example.com',
  });

const fails = (...codes: string[]) =>
  jsonResponse({ success: false, 'error-codes': codes, messages: [] });

// an abort the way fetch reports it, made in this realm so instanceof checks see an Error
const abortError = () =>
  Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

// a fetch that never answers and gives up when the request is aborted
const hangingFetch = () =>
  jest.spyOn(globalThis, 'fetch').mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()));
      }),
  );

// what the log and the error of a refusal may not hold: the answer of the visitor and the secret
const leaks = (value: unknown) => {
  const text = JSON.stringify(value);
  return text.includes(TOKEN) || text.includes(env.TURNSTILE_SECRET_KEY);
};

describe('verifyCaptcha: a good answer', () => {
  it('passes when siteverify says success', async () => {
    stubFetch(() => passes());

    await expect(verifyCaptcha({ token: TOKEN, ip: IP, log: logger() })).resolves.toBeUndefined();
  });

  it('asks siteverify once, by POST, with the secret, the answer and the address of the visitor', async () => {
    const calls = stubFetch(() => passes());

    await verifyCaptcha({ token: TOKEN, ip: IP, log: logger() });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: TURNSTILE_SITEVERIFY_URL, method: 'POST' });
    expect(TURNSTILE_SITEVERIFY_URL).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    expect(calls[0]!.headers['content-type']).toContain('application/x-www-form-urlencoded');

    const form = new URLSearchParams(calls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({
      secret: env.TURNSTILE_SECRET_KEY,
      response: TOKEN,
      remoteip: IP,
    });
  });

  // the secret goes to Cloudflare and nowhere else: a redirect would carry the form to another host
  it('does not follow a redirect with the form', async () => {
    const calls = stubFetch(() => passes());

    await verifyCaptcha({ token: TOKEN, ip: IP, log: logger() });

    expect(calls[0]!.redirect).toBe('error');
  });

  it('leaves the address out when there is none', async () => {
    const calls = stubFetch(() => passes());

    await verifyCaptcha({ token: TOKEN, ip: undefined, log: logger() });
    await verifyCaptcha({ token: TOKEN, ip: '', log: logger() });

    for (const call of calls) {
      expect([...new URLSearchParams(call.body).keys()]).toEqual(['secret', 'response']);
    }
  });

  it('sends the answer as it is, without cutting it', async () => {
    const calls = stubFetch(() => passes());
    const padded = `  ${TOKEN}  `;

    await verifyCaptcha({ token: padded, ip: IP, log: logger() });

    expect(new URLSearchParams(calls[0]!.body).get('response')).toBe(padded);
  });

  // the secret of a test, or the one of a widget put in place at runtime, is the one asked with
  it('reads the secret on each call', async () => {
    const calls = stubFetch(() => passes());
    const before = env.TURNSTILE_SECRET_KEY;

    try {
      env.TURNSTILE_SECRET_KEY = '2x0000000000000000000000000000000AA';
      await verifyCaptcha({ token: TOKEN, ip: IP, log: logger() });
    } finally {
      env.TURNSTILE_SECRET_KEY = before;
    }
    await verifyCaptcha({ token: TOKEN, ip: IP, log: logger() });

    expect(calls.map((call) => new URLSearchParams(call.body).get('secret'))).toEqual([
      '2x0000000000000000000000000000000AA',
      before,
    ]);
  });
});

describe('verifyCaptcha: an answer that is no good (400 CAPTCHA_INVALID)', () => {
  // what the visitor can mend by solving the widget again: a wrong, used or missing answer
  it.each([
    ['invalid-input-response'],
    ['timeout-or-duplicate'],
    ['missing-input-response'],
    ['bad-request'],
    ['a-code-cloudflare-adds-later'],
  ])('refuses when siteverify says %s', async (code) => {
    stubFetch(() => fails(code));
    const log = logger();

    const err = await rejectedBy(() => verifyCaptcha({ token: TOKEN, ip: IP, log }));

    expect(err).toMatchObject({ statusCode: 400, errorCode: 'CAPTCHA_INVALID' });
    // an answer that fails is a visitor's miss, not a fault of the server
    expect(log.warn).not.toHaveBeenCalled();
    expect(leaks({ message: (err as Error).message, err })).toBe(false);
  });

  it('refuses when siteverify says failure with no code at all', async () => {
    stubFetch(() => jsonResponse({ success: false }));

    expect(
      await rejectedBy(() => verifyCaptcha({ token: TOKEN, ip: IP, log: logger() })),
    ).toMatchObject({ statusCode: 400, errorCode: 'CAPTCHA_INVALID' });
  });

  it('refuses when siteverify answers a failure in a 4xx with a json body', async () => {
    stubFetch(() => jsonResponse({ success: false, 'error-codes': ['bad-request'] }, 400));

    expect(
      await rejectedBy(() => verifyCaptcha({ token: TOKEN, ip: IP, log: logger() })),
    ).toMatchObject({ errorCode: 'CAPTCHA_INVALID' });
  });

  // nothing to check: no call is made, and the visitor is asked for an answer
  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a number', 12],
    ['an object', { token: TOKEN }],
    ['an empty text', ''],
    ['a text of spaces', '   '],
  ])('refuses %s as the answer, without a call to Cloudflare', async (_case, token) => {
    const calls = stubFetch(() => passes());

    const err = await rejectedBy(() => verifyCaptcha({ token, ip: IP, log: logger() }));

    expect(err).toMatchObject({ statusCode: 400, errorCode: 'CAPTCHA_INVALID' });
    expect(calls).toHaveLength(0);
  });
});

describe('verifyCaptcha: Cloudflare cannot say (503 CAPTCHA_UNAVAILABLE)', () => {
  const unavailable = async (log = logger()) => {
    const err = await rejectedBy(() => verifyCaptcha({ token: TOKEN, ip: IP, log }));

    expect(err).toMatchObject({ statusCode: 503, errorCode: 'CAPTCHA_UNAVAILABLE' });
    expect(leaks({ message: (err as Error).message, err })).toBe(false);
    return log;
  };

  it('refuses when the request does not reach Cloudflare, and warns', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));

    const log = await unavailable();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ reason: 'REQUEST_FAILED' });
    expect(leaks(log.warn.mock.calls)).toBe(false);
  });

  it.each([500, 502, 503, 504])(
    'refuses on a %s of Cloudflare, and warns with the status',
    async (status) => {
      stubFetch(() => textResponse('<html>failure</html>', status));

      const log = await unavailable();

      expect(log.warn.mock.calls[0]![0]).toMatchObject({ reason: 'SERVER_ERROR', status });
      expect(leaks(log.warn.mock.calls)).toBe(false);
    },
  );

  // a 5xx is no verdict on the visitor even when its body is json that says failure
  it('refuses on a 5xx whose body says success, or failure', async () => {
    for (const body of [{ success: true }, { success: false, 'error-codes': ['internal-error'] }]) {
      stubFetch(() => jsonResponse(body, 500));
      await unavailable();
      jest.restoreAllMocks();
    }
  });

  it.each([
    ['a page that is no json', () => textResponse('<html>Just a moment...</html>')],
    ['an empty body', () => textResponse('')],
    ['json that is no object', () => jsonResponse('success')],
    ['a json null', () => jsonResponse(null)],
    ['a json list', () => jsonResponse([{ success: true }])],
    ['an object with no success', () => jsonResponse({ 'error-codes': [] })],
    ['a success that is no boolean', () => jsonResponse({ success: 'true' })],
    ['a 4xx that is no json', () => textResponse('forbidden', 403)],
  ])('refuses on %s, and warns', async (_case, answer) => {
    stubFetch(answer);

    const log = await unavailable();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ reason: 'ANSWER_UNREADABLE' });
    expect(leaks(log.warn.mock.calls)).toBe(false);
  });

  // the visitor cannot mend the secret of the shop or a fault of Cloudflare by solving the widget
  // again: it is the server that is out of order, and the log says what Cloudflare said
  it.each([
    ['invalid-input-secret', 400],
    ['missing-input-secret', 400],
    ['internal-error', 200],
  ])(
    'refuses when siteverify says %s (a fault of the server side), and warns with it',
    async (code, status) => {
      stubFetch(() =>
        jsonResponse({ success: false, 'error-codes': [code], messages: [] }, status),
      );

      const log = await unavailable();

      expect(log.warn.mock.calls[0]![0]).toMatchObject({
        reason: 'SITEVERIFY_FAULT',
        errorCodes: [code],
      });
      expect(leaks(log.warn.mock.calls)).toBe(false);
    },
  );

  it('refuses on a fault code even when it comes with the code of a failed answer', async () => {
    stubFetch(() => fails('invalid-input-response', 'internal-error'));

    await unavailable();
  });

  describe('time', () => {
    it('gives up after 5 seconds and warns', async () => {
      expect(TURNSTILE_TIMEOUT_MS).toBe(5000);
      jest.useFakeTimers();
      hangingFetch();
      const log = logger();

      let settled = false;
      const pending = verifyCaptcha({ token: TOKEN, ip: IP, log }).finally(() => {
        settled = true;
      });
      pending.catch(() => undefined);

      await jest.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(await rejectedBy(() => pending)).toMatchObject({
        statusCode: 503,
        errorCode: 'CAPTCHA_UNAVAILABLE',
      });
      expect(log.warn.mock.calls[0]![0]).toMatchObject({ reason: 'TIMEOUT' });
      expect(leaks(log.warn.mock.calls)).toBe(false);
    });

    // the headers came in time, the body did not: the same timeout
    it('gives up on a body that stalls', async () => {
      jest.useFakeTimers();
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(abortError()));
          },
        });

        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const pending = verifyCaptcha({ token: TOKEN, ip: IP, log: logger() });
      pending.catch(() => undefined);

      await jest.advanceTimersByTimeAsync(TURNSTILE_TIMEOUT_MS);
      expect(await rejectedBy(() => pending)).toMatchObject({ errorCode: 'CAPTCHA_UNAVAILABLE' });
    });

    it.each([
      ['an answer that passes', () => passes()],
      ['an answer that fails', () => fails('invalid-input-response')],
      ['a failure of Cloudflare', () => textResponse('', 502)],
    ])('leaves no timer behind after %s', async (_case, answer) => {
      jest.useFakeTimers();
      stubFetch(answer);

      await verifyCaptcha({ token: TOKEN, ip: IP, log: logger() }).catch(() => undefined);

      expect(jest.getTimerCount()).toBe(0);
    });

    it('passes the signal of the timeout to the request', async () => {
      const calls = stubFetch(() => passes());

      await verifyCaptcha({ token: TOKEN, ip: IP, log: logger() });

      expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    });
  });
});

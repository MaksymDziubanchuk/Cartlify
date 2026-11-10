import env from '@config/env.js';

import { TURNSTILE_TEST_SECRETS } from '../setup/isolateEnv.js';
import { isRealService } from './services.js';

// Cloudflare Turnstile in the integration tests (tests/setup/integration.turnstile.ts puts it in
// place for every file):
// - a mock by default, it answers the way siteverify does for the dummy secrets Cloudflare publishes
//   (checked against the real service on 08.11.2026, tests/integration/api/auth/turnstileAnswers.test.ts
//   holds it there): the secret of the tests passes any response, another dummy secret fails it, an
//   unknown or missing secret is a 400;
// - the real service when the run names it (npm test -- service:turnstile): the same requests go to
//   siteverify with the same dummy secrets, which need no widget, no account and no secret of the repository.
// The secret of the app in the tests is the dummy one that passes (tests/setup/isolateEnv.ts), so a
// test gets a failed captcha by putting another dummy secret in its place for the time of the test
// (failCaptcha), and a Cloudflare that does not answer by outage (breakTurnstile)
export const TURNSTILE_SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const realTurnstile = isRealService('turnstile');

// what a widget with a dummy site key gives the page; the dummy secret that passes takes any other
// text as well
export const CAPTCHA_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

// the body of a request with the answer of the captcha: the field the routes read
export const withCaptcha = <T extends object>(body: T): T & { captchaToken: string } => ({
  ...body,
  captchaToken: CAPTCHA_TOKEN,
});

export type SiteverifyAnswer = { status: number; body: Record<string, unknown> };

// the answer of siteverify to a secret and a response, as the real service gives it (08.11.2026),
// in the order it checks: no secret is a 400 missing-input-secret; no response is a 200
// missing-input-response, whatever the secret; a secret it does not know is a 400
// invalid-input-secret; the dummy secrets answer for any response, the one that passes with the time
// and the hostname of a test, the others with their error
export function siteverifyMock(
  secret: string,
  response: string,
  now = new Date(),
): SiteverifyAnswer {
  if (!secret) {
    return {
      status: 400,
      body: { 'error-codes': ['missing-input-secret'], success: false, messages: [] },
    };
  }

  if (!response) {
    return {
      status: 200,
      body: { 'error-codes': ['missing-input-response'], success: false, messages: [] },
    };
  }

  if (!Object.values<string>(TURNSTILE_TEST_SECRETS).includes(secret)) {
    return {
      status: 400,
      body: { 'error-codes': ['invalid-input-secret'], success: false, messages: [] },
    };
  }

  const failure = (code: string): SiteverifyAnswer => ({
    status: 200,
    body: {
      'error-codes': [code],
      success: false,
      messages: [],
      metadata: { result_with_testing_key: true },
    },
  });

  if (secret === TURNSTILE_TEST_SECRETS.fail) return failure('invalid-input-response');
  if (secret === TURNSTILE_TEST_SECRETS.spent) return failure('timeout-or-duplicate');

  return {
    status: 200,
    body: {
      challenge_ts: now.toISOString(),
      'error-codes': [],
      hostname: 'example.com',
      metadata: { result_with_testing_key: true },
      success: true,
    },
  };
}

// one request of the app to siteverify, as the app sent it
export type CaptchaCall = {
  method: string;
  contentType: string;
  secret: string;
  response: string;
  // the address of the visitor, null when the request names none
  remoteip: string | null;
  // the status of the answer (the mock's, the real one's or the outage's), null when none came
  status: number | null;
};

// the ways Cloudflare does not answer
export type TurnstileOutage = 'unreachable' | 'server-error' | 'not-json' | 'hangs';

// the requests each watchCaptcha of the running test collects; reset after every test
const watchers = new Set<CaptchaCall[]>();
let outage: TurnstileOutage | null = null;
let secretBefore: string | null = null;

const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

// the answer of Cloudflare during an outage: nothing at all, a failure of its server, a page that
// is no json, or no answer until the app gives up
function outageAnswer(kind: TurnstileOutage, init: RequestInit | undefined): Promise<Response> {
  switch (kind) {
    case 'unreachable':
      return Promise.reject(new TypeError('fetch failed'));
    case 'server-error':
      return Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 }));
    case 'not-json':
      return Promise.resolve(new Response('<html>Just a moment...</html>', { status: 200 }));
    case 'hangs':
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener('abort', () => reject(abortError()));
      });
  }
}

// in place for the whole test file, by assignment and not jest.spyOn: restoreAllMocks of a test must
// not take it away. Every other request passes untouched
export function installTurnstile(): void {
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== TURNSTILE_SITEVERIFY) return realFetch(input, init);

    const form = new URLSearchParams(String(init?.body ?? ''));
    const call: CaptchaCall = {
      method: init?.method ?? 'GET',
      contentType: new Headers(init?.headers).get('content-type') ?? '',
      secret: form.get('secret') ?? '',
      response: form.get('response') ?? '',
      remoteip: form.get('remoteip'),
      status: null,
    };
    watchers.forEach((calls) => calls.push(call));

    const answer = outage
      ? await outageAnswer(outage, init)
      : realTurnstile
        ? await realFetch(input, init)
        : (() => {
            const { status, body } = siteverifyMock(call.secret, call.response);
            return new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            });
          })();

    call.status = answer.status;
    return answer;
  }) as typeof fetch;
}

// after every test: the secret of the app, the outage and the watchers are what they were
export function resetTurnstile(): void {
  watchers.clear();
  outage = null;
  if (secretBefore !== null) env.TURNSTILE_SECRET_KEY = secretBefore;
  secretBefore = null;
}

// a copy of every request the app sends to siteverify from now until the test ends
export function watchCaptcha(): CaptchaCall[] {
  const calls: CaptchaCall[] = [];
  watchers.add(calls);
  return calls;
}

// the app asks siteverify with this secret until the test ends
export function useCaptchaSecret(secret: string): void {
  secretBefore ??= env.TURNSTILE_SECRET_KEY;
  env.TURNSTILE_SECRET_KEY = secret;
}

// siteverify fails every response (invalid-input-response) until the test ends: the dummy secret
// that fails takes the place of the one that passes
export function failCaptcha(): void {
  useCaptchaSecret(TURNSTILE_TEST_SECRETS.fail);
}

// siteverify says every response was used before (timeout-or-duplicate) until the test ends
export function spendCaptcha(): void {
  useCaptchaSecret(TURNSTILE_TEST_SECRETS.spent);
}

// Cloudflare does not answer the way the outage says until the test ends; in both modes the request
// never reaches the real service
export function breakTurnstile(kind: TurnstileOutage): void {
  outage = kind;
}

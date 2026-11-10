import env from '@config/env.js';
import { BadRequestError, ServiceUnavailableError } from '@utils/errors.js';

// Cloudflare Turnstile, the captcha of the forms that send a mail or open an account for anybody
// (the registration, the mail of a password reset, the mail of a verification, the subscription to
// the newsletters). The page shows a widget; the visitor who solved it gets an answer (a token), the
// page sends it in the field captchaToken of the body, and siteverify says whether it is good. An
// answer works once: Cloudflare takes it spent after the first check.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Cloudflare answers in well under a second; a visitor waits for this at most
export const TURNSTILE_TIMEOUT_MS = 5000;

// what a failed check is logged with: the logger of the request
export type CaptchaLogger = { warn: (obj: unknown, msg?: string) => void };

// The codes of siteverify that say the visitor is not the one at fault: the secret of the shop is
// missing or wrong, or Cloudflare itself failed. Solving the widget again mends none of them, so
// the request is refused as unavailable (503), not as a captcha that failed (400), and the log tells.
// The other codes (invalid-input-response, timeout-or-duplicate, missing-input-response,
// bad-request, and any a later version of Cloudflare adds) are the answer of the visitor
const SERVER_SIDE_CODES = new Set([
  'invalid-input-secret',
  'missing-input-secret',
  'internal-error',
]);

type Reason =
  'REQUEST_FAILED' | 'TIMEOUT' | 'SERVER_ERROR' | 'ANSWER_UNREADABLE' | 'SITEVERIFY_FAULT';

// A Cloudflare that cannot say must not let a request through: the check fails closed. The warning
// names what went wrong and holds neither the answer of the visitor nor the secret
function unavailable(
  log: CaptchaLogger,
  reason: Reason,
  extra: Record<string, unknown> = {},
): never {
  log.warn({ reason, ...extra }, 'captcha could not be checked');
  throw new ServiceUnavailableError('CAPTCHA_UNAVAILABLE');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// the codes of an answer as they are logged: short words of Cloudflare, not the text of an answer
const codesOf = (body: Record<string, unknown>): string[] => {
  const codes = body['error-codes'];

  return Array.isArray(codes)
    ? codes
        .filter(
          (code): code is string => typeof code === 'string' && /^[a-z0-9-]{1,64}$/.test(code),
        )
        .slice(0, 10)
    : [];
};

// Checks the answer of the widget the visitor sent. Resolves when it is good; 400 CAPTCHA_INVALID
// when it is missing or Cloudflare refuses it; 503 CAPTCHA_UNAVAILABLE when Cloudflare gives no
// verdict (no answer in time, a failure, something that is no json) or the shop's own secret is not
// taken. The secret is read on each call. The address of the visitor goes along when it is known
export async function verifyCaptcha(input: {
  token: unknown;
  ip: string | undefined;
  log: CaptchaLogger;
}): Promise<void> {
  const { token, ip, log } = input;

  // nothing to check, and nothing to ask Cloudflare
  if (typeof token !== 'string' || !token.trim()) throw new BadRequestError('CAPTCHA_INVALID');

  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (ip) form.set('remoteip', ip);

  // the timer runs until the body is read: an answer that stalls half way is no answer either
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS);

  let status = 0;
  let text = '';
  try {
    // no redirect: the form holds the secret, it goes to Cloudflare and nowhere else
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: controller.signal,
      redirect: 'error',
    });
    status = res.status;
    text = await res.text();
  } catch {
    // the error of fetch may quote the address it called, and nothing of the request
    unavailable(log, controller.signal.aborted ? 'TIMEOUT' : 'REQUEST_FAILED');
  } finally {
    clearTimeout(timer);
  }

  if (status >= 500) unavailable(log, 'SERVER_ERROR', { status });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  // a success is a 2xx with success: true; a body that says anything else is not a verdict
  if (!isRecord(body) || typeof body.success !== 'boolean' || (body.success && status >= 300)) {
    unavailable(log, 'ANSWER_UNREADABLE', { status });
  }

  if (body.success) return;

  const errorCodes = codesOf(body);
  if (errorCodes.some((code) => SERVER_SIDE_CODES.has(code))) {
    unavailable(log, 'SITEVERIFY_FAULT', { status, errorCodes });
  }

  throw new BadRequestError('CAPTCHA_INVALID');
}

import { createHash } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import env from '@config/env.js';
import { TooManyRequestsError } from '@utils/errors.js';

// The limits of the routes a script would abuse, on top of the limit of every route
// (@fastify/rate-limit, RATE_LIMIT_MAX a minute from one address): the login (by address and by
// email, and a pause of an account after wrong passwords), the registration, the mails of a
// password reset and of a verification (one to an address in 3 minutes, so a script cannot empty
// the plan of the mail provider and stop the mails of orders), the payment page.
// The counts live in the memory of this copy of the server; with several copies they move to
// redis. REQUEST_LIMITS_SCALE multiplies every limit (the tests raise them a thousand times)

const MINUTE = 60_000;

type Limit = { max: number; windowMs: number };

export const REQUEST_LIMITS = {
  loginPerAddress: { max: 30, windowMs: 10 * MINUTE },
  loginPerEmail: { max: 10, windowMs: 10 * MINUTE },
  registerPerAddress: { max: 10, windowMs: 60 * MINUTE },
  mailPerAddress: { max: 10, windowMs: 15 * MINUTE },
  mailPerEmail: { max: 1, windowMs: 3 * MINUTE },
  checkoutPerUser: { max: 10, windowMs: MINUTE },
  // a session that guesses the current password to change it
  passwordChangePerUser: { max: 10, windowMs: 15 * MINUTE },
  // the export of the data of a person reads every table of the person
  exportPerUser: { max: 1, windowMs: 60 * MINUTE },
} as const satisfies Record<string, Limit>;

// the wrong passwords of an account before its login pauses; the pause starts at a minute and
// doubles with each next wrong password, up to 15 minutes; the count is forgotten an hour after
// the last wrong password, or at once by the right one
const LOGIN_FAILURES_BEFORE_PAUSE = 5;
const LOGIN_PAUSE_MS = MINUTE;
const LOGIN_PAUSE_MAX_MS = 15 * MINUTE;
const LOGIN_FAILURES_KEPT_MS = 60 * MINUTE;

// how many requests go by before the counts that are over are cleared
const SWEEP_EVERY = 1000;

const scaled = (max: number) => max * env.REQUEST_LIMITS_SCALE;

// an email names the account the same way whatever its case; only its hash is kept in memory
const emailKey = (email: unknown) =>
  createHash('sha256')
    .update(
      String(email ?? '')
        .trim()
        .toLowerCase(),
    )
    .digest('hex');

const secondsUntil = (time: number, now: number) => Math.max(1, Math.ceil((time - now) / 1000));

// the requests of each key in a window of fixed length
class WindowCounter {
  private windows = new Map<string, { count: number; resetAt: number }>();
  private calls = 0;

  constructor(private readonly limit: Limit) {}

  // counts one more request of the key; the seconds to wait when it is over the limit, else null
  take(key: string, now = Date.now()): number | null {
    if ((this.calls += 1) % SWEEP_EVERY === 0) this.sweep(now);

    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.limit.windowMs };
      this.windows.set(key, window);
    }

    window.count += 1;
    return window.count > scaled(this.limit.max) ? secondsUntil(window.resetAt, now) : null;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

type KeyOf = (req: FastifyRequest) => string;

// a preHandler that refuses the request over the limit with 429 RATE_LIMITED, naming the limit
// and the seconds to wait (the retry-after header too)
function limitBy(name: string, limit: Limit, keyOf: KeyOf) {
  const counter = new WindowCounter(limit);

  return async function requestLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const wait = counter.take(keyOf(req));
    if (wait === null) return;

    reply.header('retry-after', String(wait));
    throw new TooManyRequestsError('RATE_LIMITED', { limit: name, retryAfterSeconds: wait });
  };
}

const byAddress: KeyOf = (req) => `ip:${req.ip}`;
const byEmail: KeyOf = (req) =>
  `email:${emailKey((req.body as { email?: unknown } | undefined)?.email)}`;
const byUser: KeyOf = (req) => `user:${String(req.user?.id ?? req.ip)}`;

// the wrong passwords of each account
const loginFailures = new Map<string, { count: number; pausedUntil: number; lastAt: number }>();
let loginCalls = 0;

function sweepLoginFailures(now: number): void {
  for (const [key, failures] of loginFailures) {
    if (failures.lastAt + LOGIN_FAILURES_KEPT_MS <= now) loginFailures.delete(key);
  }
}

// a preHandler of the login: an account that paused after wrong passwords is refused with
// 429 LOGIN_PAUSED for the rest of its pause, the right password too
async function loginPause(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const now = Date.now();
  if ((loginCalls += 1) % SWEEP_EVERY === 0) sweepLoginFailures(now);

  const failures = loginFailures.get(emailKey((req.body as { email?: unknown })?.email));
  if (!failures || failures.pausedUntil <= now) return;

  const wait = secondsUntil(failures.pausedUntil, now);
  reply.header('retry-after', String(wait));
  throw new TooManyRequestsError('LOGIN_PAUSED', { retryAfterSeconds: wait });
}

// a wrong password of the account of this email, also of an email without an account: the answer
// must not tell them apart
export function recordLoginFailure(email: string, now = Date.now()): void {
  const key = emailKey(email);
  const failures = loginFailures.get(key);
  const count =
    (failures && failures.lastAt + LOGIN_FAILURES_KEPT_MS > now ? failures.count : 0) + 1;
  const threshold = scaled(LOGIN_FAILURES_BEFORE_PAUSE);

  const pause =
    count >= threshold
      ? Math.min(LOGIN_PAUSE_MS * 2 ** (count - threshold), LOGIN_PAUSE_MAX_MS)
      : 0;

  loginFailures.set(key, { count, pausedUntil: now + pause, lastAt: now });
}

// the right password: the count of the account starts over
export function clearLoginFailures(email: string): void {
  loginFailures.delete(emailKey(email));
}

// the preHandlers of each route, after its guards (the checkout counts the requests of a user)
export const requestLimits = {
  login: [
    limitBy('login', REQUEST_LIMITS.loginPerAddress, byAddress),
    limitBy('login', REQUEST_LIMITS.loginPerEmail, byEmail),
    loginPause,
  ],
  register: [limitBy('register', REQUEST_LIMITS.registerPerAddress, byAddress)],
  mail: [
    limitBy('mail', REQUEST_LIMITS.mailPerAddress, byAddress),
    limitBy('mail', REQUEST_LIMITS.mailPerEmail, byEmail),
  ],
  checkout: [limitBy('checkout', REQUEST_LIMITS.checkoutPerUser, byUser)],
  passwordChange: [limitBy('passwordChange', REQUEST_LIMITS.passwordChangePerUser, byUser)],
  export: [limitBy('export', REQUEST_LIMITS.exportPerUser, byUser)],
};

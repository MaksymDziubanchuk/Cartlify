import { createHash } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import env from '@config/env.js';
import { isWithdrawalCode } from '@helpers/withdrawalCode.js';
import { TooManyRequestsError } from '@utils/errors.js';

// The limits of the routes a script would abuse, on top of the limit of every route
// (@fastify/rate-limit, RATE_LIMIT_MAX a minute from one address): the login (by address and by
// email, and a pause of an account after wrong passwords), the registration, the mails of a
// password reset and of a verification (one to an address in 3 minutes, so a script cannot empty
// the plan of the mail provider and stop the mails of orders), the payment page, a review.
// The counts live in the memory of this copy of the server; with several copies they move to
// redis. The most requests of each limit is a setting (LIMIT_*, read on each request, the windows
// stay here); REQUEST_LIMITS_SCALE multiplies every limit (the tests raise them a thousand times)

const MINUTE = 60_000;

type Limit = { readonly max: number; windowMs: number };

export const REQUEST_LIMITS = {
  loginPerAddress: {
    get max() {
      return env.LIMIT_LOGIN_PER_ADDRESS;
    },
    windowMs: 10 * MINUTE,
  },
  loginPerEmail: {
    get max() {
      return env.LIMIT_LOGIN_PER_EMAIL;
    },
    windowMs: 10 * MINUTE,
  },
  registerPerAddress: {
    get max() {
      return env.LIMIT_REGISTER_PER_ADDRESS;
    },
    windowMs: 60 * MINUTE,
  },
  mailPerAddress: {
    get max() {
      return env.LIMIT_MAIL_PER_ADDRESS;
    },
    windowMs: 15 * MINUTE,
  },
  mailPerEmail: {
    get max() {
      return env.LIMIT_MAIL_PER_EMAIL;
    },
    windowMs: 3 * MINUTE,
  },
  checkoutPerUser: {
    get max() {
      return env.LIMIT_CHECKOUT_PER_USER;
    },
    windowMs: MINUTE,
  },
  // a session that guesses the current password to change it
  passwordChangePerUser: {
    get max() {
      return env.LIMIT_PASSWORD_CHANGE_PER_USER;
    },
    windowMs: 15 * MINUTE,
  },
  // the export of the data of a person reads every table of the person
  exportPerUser: {
    get max() {
      return env.LIMIT_EXPORT_PER_USER;
    },
    windowMs: 60 * MINUTE,
  },
  // a statement of withdrawal from the account: a script would fill the queue of the admins
  withdrawalPerUser: {
    get max() {
      return env.LIMIT_WITHDRAWAL_PER_USER;
    },
    windowMs: 60 * MINUTE,
  },
  // the public form of withdrawal, its units, its routing and the proof by the code: nobody is signed
  // in, so the attempts count by address, by order and by the facts of a recipient from every
  // address (a script guessing the name of the recipient of an order from many addresses, trying the
  // orders of one person, or filling the queue of the admins). A request with the code of the order
  // counts nothing for the order and the facts: it is the buyer's, so nobody can use up their
  // requests
  withdrawalFormPerAddress: {
    get max() {
      return env.LIMIT_WITHDRAWAL_FORM_PER_ADDRESS;
    },
    windowMs: 60 * MINUTE,
  },
  withdrawalFormPerOrder: {
    get max() {
      return env.LIMIT_WITHDRAWAL_FORM_PER_ORDER;
    },
    windowMs: 60 * MINUTE,
  },
  withdrawalFormPerData: {
    get max() {
      return env.LIMIT_WITHDRAWAL_FORM_PER_DATA;
    },
    windowMs: 60 * MINUTE,
  },
  // the proof of a parcel is written again until the shop confirms it, each time a line of the log
  proofPerUser: {
    get max() {
      return env.LIMIT_WITHDRAWAL_PER_USER * 3;
    },
    windowMs: 60 * MINUTE,
  },
  // the button "call an admin" of a chat the bot could not answer; a script would fill the queue of
  // the admins
  chatCallAdminPerUser: {
    get max() {
      return env.LIMIT_CHAT_CALL_ADMIN_PER_USER;
    },
    windowMs: 60 * MINUTE,
  },
  // a comment of a review asks the model of openai; a refused one writes nothing and comes again
  reviewPerUser: {
    get max() {
      return env.LIMIT_REVIEW_PER_USER;
    },
    windowMs: 60 * MINUTE,
  },
} as const satisfies Record<string, Limit>;

// the wrong passwords of an account before its login pauses (LOGIN_FAILURES_BEFORE_PAUSE, 5
// unless set); the pause starts at a minute and doubles with each next wrong password, up to 15
// minutes; the count is forgotten an hour after the last wrong password, or at once by the right one
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

// the key a request counts under; none: the request does not count for this limit
type KeyOf = (req: FastifyRequest) => string | null;

// a preHandler that refuses the request over the limit with 429 RATE_LIMITED, naming the limit
// and the seconds to wait (the retry-after header too)
function limitBy(name: string, limit: Limit, keyOf: KeyOf) {
  const counter = new WindowCounter(limit);

  return async function requestLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const key = keyOf(req);
    if (key === null) return;

    const wait = counter.take(key);
    if (wait === null) return;

    reply.header('retry-after', String(wait));
    throw new TooManyRequestsError('RATE_LIMITED', { limit: name, retryAfterSeconds: wait });
  };
}

const byAddress: KeyOf = (req) => `ip:${req.ip}`;
const byEmail: KeyOf = (req) =>
  `email:${emailKey((req.body as { email?: unknown } | undefined)?.email)}`;
const byUser: KeyOf = (req) => `user:${String(req.user?.id ?? req.ip)}`;
// one order from every address, for the requests without its code: the code comes with the mails
// of the buyer and cannot be guessed (the limit of the address stops a try), so a request with it
// is the buyer's and counts nothing, and nobody can use up the requests of the real buyer
const byOrderWithoutCode: KeyOf = (req) => {
  const body = req.body as { orderId?: unknown; code?: unknown } | undefined;
  const orderId = Number(body?.orderId);
  if (Number.isSafeInteger(orderId) && orderId > 0 && isWithdrawalCode(orderId, body?.code)) {
    return null;
  }
  return `order:${String(body?.orderId ?? '')}`;
};

// the facts of a recipient from every address, for the requests without the code of the order: the
// phone by its digits, or the name when no phone is given; only a hash is kept in memory. A request
// that gives neither (the routing of a link, the proof) does not count here
const byDataWithoutCode: KeyOf = (req) => {
  const body = req.body as
    { orderId?: unknown; code?: unknown; phone?: unknown; recipientName?: unknown } | undefined;
  const orderId = Number(body?.orderId);
  if (Number.isSafeInteger(orderId) && orderId > 0 && isWithdrawalCode(orderId, body?.code)) {
    return null;
  }
  const phone = String(body?.phone ?? '').replace(/\D/g, '');
  const name = String(body?.recipientName ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (!phone && !name) return null;
  return `data:${createHash('sha256')
    .update(phone ? `phone:${phone}` : `name:${name}`)
    .digest('hex')}`;
};

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
  const threshold = scaled(env.LOGIN_FAILURES_BEFORE_PAUSE);

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
  review: [limitBy('review', REQUEST_LIMITS.reviewPerUser, byUser)],
  chatCallAdmin: [limitBy('chatCallAdmin', REQUEST_LIMITS.chatCallAdminPerUser, byUser)],
  withdrawal: [limitBy('withdrawal', REQUEST_LIMITS.withdrawalPerUser, byUser)],
  proof: [limitBy('proof', REQUEST_LIMITS.proofPerUser, byUser)],
  withdrawalForm: [
    limitBy('withdrawalForm', REQUEST_LIMITS.withdrawalFormPerAddress, byAddress),
    limitBy('withdrawalForm', REQUEST_LIMITS.withdrawalFormPerOrder, byOrderWithoutCode),
    limitBy('withdrawalForm', REQUEST_LIMITS.withdrawalFormPerData, byDataWithoutCode),
  ],
};

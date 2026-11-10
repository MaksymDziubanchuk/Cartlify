import { createHash } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import env from '@config/env.js';
import { blocklistAddressOf } from '@helpers/newsletterTokens.js';
import { isWithdrawalCode } from '@helpers/withdrawalCode.js';
import { TooManyRequestsError } from '@utils/errors.js';

// The limits of the routes a script would abuse, on top of the limit of every route
// (@fastify/rate-limit, RATE_LIMIT_MAX a minute from one address): the login (by address and by
// email, and a pause of an account after wrong passwords), the registration (by address, and by
// email: it mails a new link to an address that is not verified yet), the mails of a
// password reset and of a verification (one to an address in 3 minutes, so a script cannot empty
// the plan of the mail provider and stop the mails of orders), the form of the newsletters (it mails
// anybody, so it counts like those), the pages behind the links of their mails and the unsubscribe
// button of the mails, the payment page, a review, the translation of the texts of a campaign (both
// ask the model of openai), the test mail of a campaign.
// The forms that have a captcha count the requests of an address before it and the requests of an
// email after it: a request that fails the captcha must not use up the one mail a person may ask for
// in 3 minutes, or a script without a captcha could keep the mails of a person from them. The email of
// a registration counts the registrations that succeed: a person whose form is refused after the
// captcha (the account is there, the password is short) corrects it and sends it again at once.
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
  // a registration of an address that is not verified yet takes the account again and mails a new link,
  // each time: one registration of an email in 3 minutes, counted apart from the mails of a reset and of
  // a verification (a person who registers and asks for the mail again is not refused). Only the
  // registrations that succeed count (limitBySuccess)
  registerPerEmail: {
    get max() {
      return env.LIMIT_REGISTER_PER_EMAIL;
    },
    windowMs: 3 * MINUTE,
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
  // the pages behind the links of the mails of the newsletters (confirm, "this is not me", the page
  // of management). The tokens are too long to guess, so this only keeps a script from loading the
  // database; a person uses a few requests
  newsletterLinkPerAddress: {
    get max() {
      return env.LIMIT_NEWSLETTER_LINK_PER_ADDRESS;
    },
    windowMs: 10 * MINUTE,
  },
  // the unsubscribe button of the mails: the one-click POST of a mail client (RFC 8058) and the GET
  // of the link that opens the page of the unsubscribe. A count of its own and a wide one: a mailbox
  // provider unsubscribes many readers from the few addresses of its servers, and an answer 429 would
  // leave a reader subscribed, which the rules of Gmail and Yahoo for bulk senders do not allow
  newsletterUnsubscribePerAddress: {
    get max() {
      return env.LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS;
    },
    windowMs: 10 * MINUTE,
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
  // the translation of the texts of a campaign asks the model of openai once for each language, with
  // texts of thousands of characters: a request costs more than a review does
  newsletterTranslatePerUser: {
    get max() {
      return env.LIMIT_NEWSLETTER_TRANSLATE_PER_USER;
    },
    windowMs: 60 * MINUTE,
  },
  // the test mail of a campaign is a real mail of the stream of the newsletters, to the address of an
  // admin: a loop could fill a mailbox, or use up the plan of the stream
  newsletterTestPerUser: {
    get max() {
      return env.LIMIT_NEWSLETTER_TEST_PER_USER;
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

// A mailbox is what a mail reaches, and an address can be written many ways for one mailbox: a +tag
// on any provider, the dots of a Gmail name, googlemail.com for gmail.com. The counts of the mails to
// an email are by mailbox, folded the way the blocklist of the newsletters folds an address
// (blocklistAddressOf), or a script would write to one mailbox again and again by varying the address.
// The count of a login is not: an address as it is written is an account, and the variants are other
// accounts. Only the hash is kept in memory, as for an account
const mailboxKey = (email: unknown) =>
  createHash('sha256')
    .update(blocklistAddressOf(String(email ?? '').trim()))
    .digest('hex');

const secondsUntil = (time: number, now: number) => Math.max(1, Math.ceil((time - now) / 1000));

type Window = { count: number; resetAt: number };

// the requests of each key in a window of fixed length
class WindowCounter {
  private windows = new Map<string, Window>();
  private calls = 0;

  constructor(private readonly limit: Limit) {}

  // the window of the key that is open at `now`, a new one when there is none
  private windowOf(key: string, now: number): Window {
    if ((this.calls += 1) % SWEEP_EVERY === 0) this.sweep(now);

    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.limit.windowMs };
      this.windows.set(key, window);
    }

    return window;
  }

  // counts one more request of the key; the seconds to wait when it is over the limit, else null
  take(key: string, now = Date.now()): number | null {
    const window = this.windowOf(key, now);

    window.count += 1;
    return window.count > scaled(this.limit.max) ? secondsUntil(window.resetAt, now) : null;
  }

  // Takes a place in the window of the key when it has one: the window it was taken in. When the window
  // is full nothing is taken, and the seconds to wait come back (a request that is refused uses no
  // place)
  reserve(key: string, now = Date.now()): { window: Window } | { wait: number } {
    const window = this.windowOf(key, now);

    if (window.count >= scaled(this.limit.max)) return { wait: secondsUntil(window.resetAt, now) };

    window.count += 1;
    return { window };
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

// A limit that counts the requests that end well. A request takes its place before it runs (a place is
// left to the one who asks first, so requests at the same time cannot all pass), and gives it back at
// the end unless the answer is a success: a request refused for a reason of its own (a conflict, a
// missing consent, a short password, a mail that did not go) leaves the count as it was, and the person
// who corrects the form asks again at once. `takePlace` is the preHandler, `settle` the onSend hook of
// the route; a refused request has no place to give back
function limitBySuccess(
  name: string,
  limit: Limit,
  keyOf: KeyOf,
  succeeded: (statusCode: number) => boolean,
) {
  const counter = new WindowCounter(limit);
  const placed = new WeakMap<FastifyRequest, Window>();

  async function takePlace(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const key = keyOf(req);
    if (key === null) return;

    const place = counter.reserve(key);
    if ('wait' in place) {
      reply.header('retry-after', String(place.wait));
      throw new TooManyRequestsError('RATE_LIMITED', {
        limit: name,
        retryAfterSeconds: place.wait,
      });
    }

    placed.set(req, place.window);
  }

  async function settle(req: FastifyRequest, reply: FastifyReply, payload?: unknown) {
    const window = placed.get(req);
    if (window) {
      placed.delete(req);
      if (!succeeded(reply.statusCode)) window.count = Math.max(0, window.count - 1);
    }

    return payload;
  }

  return { takePlace, settle };
}

const byAddress: KeyOf = (req) => `ip:${req.ip}`;
// the account a login names
const byEmail: KeyOf = (req) =>
  `email:${emailKey((req.body as { email?: unknown } | undefined)?.email)}`;
// the mailbox a mail is sent to
const byMailbox: KeyOf = (req) =>
  `email:${mailboxKey((req.body as { email?: unknown } | undefined)?.email)}`;
// the mailbox a request names, when it names one: the form of the newsletters is also used by a
// signed-in user who subscribes their own address and names none, and all of them must not share
// the count of "no email"
const byBodyEmail: KeyOf = (req) => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() ? `email:${mailboxKey(email)}` : null;
};
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

// the registrations of a mailbox, counted when they succeed
const registerEmail = limitBySuccess(
  'register',
  REQUEST_LIMITS.registerPerEmail,
  byMailbox,
  (statusCode) => statusCode === 201,
);

// the preHandlers of each route, after its guards (the checkout counts the requests of a user)
export const requestLimits = {
  login: [
    limitBy('login', REQUEST_LIMITS.loginPerAddress, byAddress),
    limitBy('login', REQUEST_LIMITS.loginPerEmail, byEmail),
    loginPause,
  ],
  // the registration, in two lists that the route puts on both sides of its captcha: the address of
  // the client before it, the mailbox of the body after it (as the mails below). The count of the
  // mailbox is spent by the registrations that end in 201: the route takes the place after the captcha
  // (registerToEmail) and gives it back in its onSend hook (registerToEmailDone) when the answer is
  // anything else
  register: [limitBy('register', REQUEST_LIMITS.registerPerAddress, byAddress)],
  registerToEmail: [registerEmail.takePlace],
  registerToEmailDone: registerEmail.settle,
  // the mails of a reset and of a verification, in two lists that a route puts on both sides of its
  // captcha: the address of the client before it, the email of the body after it
  mail: [limitBy('mail', REQUEST_LIMITS.mailPerAddress, byAddress)],
  mailToEmail: [limitBy('mail', REQUEST_LIMITS.mailPerEmail, byMailbox)],
  // the form that mails an address of anybody: the same budget as the other mails, counted apart.
  // The address of the client is a preHandler before the captcha; the count of the email is a
  // function of the service (newsletterRequestEmail), called after the captcha, which the service
  // checks only for an address that is not the person's own
  newsletterRequest: [limitBy('newsletterRequest', REQUEST_LIMITS.mailPerAddress, byAddress)],
  newsletterRequestEmail: limitBy('newsletterRequest', REQUEST_LIMITS.mailPerEmail, byBodyEmail),
  // the pages behind the links of the mails of the newsletters
  newsletterLink: [limitBy('newsletterLink', REQUEST_LIMITS.newsletterLinkPerAddress, byAddress)],
  // the unsubscribe button of the mails, the POST and the GET together
  newsletterUnsubscribe: [
    limitBy('newsletterUnsubscribe', REQUEST_LIMITS.newsletterUnsubscribePerAddress, byAddress),
  ],
  checkout: [limitBy('checkout', REQUEST_LIMITS.checkoutPerUser, byUser)],
  passwordChange: [limitBy('passwordChange', REQUEST_LIMITS.passwordChangePerUser, byUser)],
  export: [limitBy('export', REQUEST_LIMITS.exportPerUser, byUser)],
  review: [limitBy('review', REQUEST_LIMITS.reviewPerUser, byUser)],
  newsletterTranslate: [
    limitBy('newsletterTranslate', REQUEST_LIMITS.newsletterTranslatePerUser, byUser),
  ],
  newsletterTest: [limitBy('newsletterTest', REQUEST_LIMITS.newsletterTestPerUser, byUser)],
  chatCallAdmin: [limitBy('chatCallAdmin', REQUEST_LIMITS.chatCallAdminPerUser, byUser)],
  withdrawal: [limitBy('withdrawal', REQUEST_LIMITS.withdrawalPerUser, byUser)],
  proof: [limitBy('proof', REQUEST_LIMITS.proofPerUser, byUser)],
  withdrawalForm: [
    limitBy('withdrawalForm', REQUEST_LIMITS.withdrawalFormPerAddress, byAddress),
    limitBy('withdrawalForm', REQUEST_LIMITS.withdrawalFormPerOrder, byOrderWithoutCode),
    limitBy('withdrawalForm', REQUEST_LIMITS.withdrawalFormPerData, byDataWithoutCode),
  ],
};

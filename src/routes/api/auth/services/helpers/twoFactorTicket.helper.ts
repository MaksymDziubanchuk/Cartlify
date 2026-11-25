import jwt from 'jsonwebtoken';
import type { FastifyReply } from 'fastify';

import env from '@config/env.js';
import type { LoginEvent, WrittenEvent } from '@config/journalEvents.js';
import { twoFactorTicketKey } from '@helpers/twoFactor/twoFactorKeys.js';
import { UnauthorizedError } from '@utils/errors.js';

import { markAuthCookiesNoStore } from './authCookies.helper.js';

// The ticket between the two steps of a login, in an httpOnly cookie: the password or the provider
// let an admin or root in, and the code of the app is still to come. It is signed with a key of its
// own (TWO_FACTOR_SECRET_KEY), so no session token passes for it and it for none. It holds no
// state of the server: a ticket used twice still needs a new code each time, and a code works once.
//   setup   - the account has no second step yet; after the setup starts it holds the new secret,
//             encrypted, until the first code of the app confirms it
//   code    - the account asks for a code of the app or a recovery code
//   replace - a signed-in admin or root moves to a new app; it holds the new secret, encrypted
export type TwoFactorStage = 'setup' | 'code' | 'replace';

export type TwoFactorTicket = {
  userId: number;
  role: 'ADMIN' | 'ROOT';
  stage: TwoFactorStage;
  // how the first step went, the event of the line of the login journal (login.password, ...)
  event: WrittenEvent<LoginEvent>;
  rememberMe: boolean;
  // the new secret of the app, encrypted (setup after it started, replace)
  pending?: string;
};

const TICKET_TYPE = 'two_factor';
// time enough to install an app and scan the code
export const TWO_FACTOR_TICKET_TTL_SEC = 10 * 60;
const COOKIE = 'twoFactorTicket';

const cookieOptions = () => ({
  httpOnly: true as const,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
});

export function signTwoFactorTicket(ticket: TwoFactorTicket): string {
  return jwt.sign({ ...ticket, type: TICKET_TYPE }, twoFactorTicketKey(), {
    expiresIn: TWO_FACTOR_TICKET_TTL_SEC,
  });
}

const invalid = () => new UnauthorizedError('TWO_FACTOR_TICKET_INVALID');

// the ticket of the cookie at the stage the route takes; a missing, expired, changed one, or one of
// another stage, is TWO_FACTOR_TICKET_INVALID: the person starts the login again
export function readTwoFactorTicket(
  cookie: string | undefined,
  stages: readonly TwoFactorStage[],
): TwoFactorTicket {
  if (!cookie) throw invalid();

  let decoded: unknown;
  try {
    decoded = jwt.verify(cookie, twoFactorTicketKey());
  } catch {
    throw invalid();
  }

  const t = decoded as Partial<TwoFactorTicket & { type: string }>;
  if (
    t.type !== TICKET_TYPE ||
    typeof t.userId !== 'number' ||
    (t.role !== 'ADMIN' && t.role !== 'ROOT') ||
    !t.stage ||
    !stages.includes(t.stage) ||
    typeof t.event !== 'string' ||
    typeof t.rememberMe !== 'boolean' ||
    (t.pending !== undefined && typeof t.pending !== 'string')
  ) {
    throw invalid();
  }

  return {
    userId: t.userId,
    role: t.role,
    stage: t.stage,
    event: t.event,
    rememberMe: t.rememberMe,
    ...(t.pending ? { pending: t.pending } : {}),
  };
}

export function setTwoFactorTicketCookie(reply: FastifyReply, ticket: TwoFactorTicket) {
  markAuthCookiesNoStore(reply);
  reply.setCookie(COOKIE, signTwoFactorTicket(ticket), {
    ...cookieOptions(),
    maxAge: TWO_FACTOR_TICKET_TTL_SEC,
  });
}

export function clearTwoFactorTicketCookie(reply: FastifyReply) {
  markAuthCookiesNoStore(reply);
  reply.clearCookie(COOKIE, cookieOptions());
}

export const twoFactorTicketCookieOf = (cookies: Record<string, string | undefined>) =>
  cookies[COOKIE];

// THE TRUSTED BROWSER: <id of the device>.<token>, the database keeps the sha256 of the token
const DEVICE_COOKIE = 'trustedDevice';
export const TRUSTED_DEVICE_TTL_SEC = 30 * 24 * 60 * 60;

export function setTrustedDeviceCookie(reply: FastifyReply, value: string) {
  markAuthCookiesNoStore(reply);
  reply.setCookie(DEVICE_COOKIE, value, { ...cookieOptions(), maxAge: TRUSTED_DEVICE_TTL_SEC });
}

export function clearTrustedDeviceCookie(reply: FastifyReply) {
  markAuthCookiesNoStore(reply);
  reply.clearCookie(DEVICE_COOKIE, cookieOptions());
}

export const trustedDeviceCookieOf = (cookies: Record<string, string | undefined>) =>
  cookies[DEVICE_COOKIE];

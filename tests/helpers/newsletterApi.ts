import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { hashToken } from '@helpers/tokenHash.js';
import {
  emailHmacOf,
  makeConfirmToken,
  makeManageSalt,
  manageHashOf,
  manageTokenOf,
  unsubscribeTokenOf,
} from '@helpers/newsletterTokens.js';
import { subscriptionMailsSent } from '@routes/api/newsletters/services/helpers/subscriptionMail.helper.js';

import { withCsrf, type Csrf } from './csrf.js';
import {
  blockRow,
  insertRow,
  removeSubscriptionRows,
  subscriptionRow,
  utc,
  type SubscriptionOpts,
} from './newsletterDb.js';
import { DAY, dbNow, journalOfAddress, subscriptionsOf } from './newsletterFns.js';
import { inOwnerTx } from './ownerDb.js';

// What the tests of the routes of the newsletters (tests/integration/api/newsletters) share: the
// requests a page of the frontend makes, and the rows they arrange or read with an owner session
// (only the owner of the database writes a subscription; the routes are what makes the state, the
// session only ages a row or reads what the routes left)

export const BASE = '/api/newsletters';
export const SUBSCRIPTIONS = `${BASE}/subscriptions`;

// the body of the answer to a request of a subscription from a guest, whatever the address is
export const REQUEST_ANSWER = {
  message: 'The request was accepted. If a message is due to this address, it was sent to it.',
};

// the pages of the frontend the links of the mails point to (src/config/env.ts, the defaults)
export const CONFIRM_PAGE = '/newsletter/confirm';
export const DECLINE_PAGE = '/newsletter/decline';
export const MANAGE_PAGE = '/newsletter/manage';

// a guest cookie fixed for a whole file: a response then holds no Set-Cookie of its own, so two
// answers can be held side by side
export const fixedGuest = () => `guestId=${randomUUID()}`;

type Options = {
  cookie?: string;
  from?: string;
  userAgent?: string;
  headers?: Record<string, string>;
};

// the requests of the pages of the frontend: the csrf pair of a browser that took a token, the
// cookie of a guest or of a signed-in user, the address the proxy names
export function newsletterApi(app: FastifyInstance, csrf: Csrf, guest = fixedGuest()) {
  const headersOf = (opts: Options) => ({
    ...withCsrf(csrf, opts.cookie ?? guest),
    ...(opts.from ? { 'x-forwarded-for': opts.from } : {}),
    ...(opts.userAgent ? { 'user-agent': opts.userAgent } : {}),
    ...opts.headers,
  });

  // the form mails after its answer: a request of these helpers returns once that mail is sent too,
  // as a person who reads the inbox after the page answered would find it
  const send = async (
    method: 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload: Record<string, unknown> | undefined,
    opts: Options,
  ) => {
    const res = await app.inject({
      method,
      url,
      headers: headersOf(opts),
      ...(payload ? { payload } : {}),
    });
    await subscriptionMailsSent();
    return res;
  };

  return {
    guest,
    post: (url: string, payload: Record<string, unknown> | undefined, opts: Options = {}) =>
      send('POST', url, payload, opts),
    patch: (url: string, payload: Record<string, unknown>, opts: Options = {}) =>
      send('PATCH', url, payload, opts),
    delete: (url: string, opts: Options = {}) => send('DELETE', url, undefined, opts),
    get: (url: string, opts: Options = {}) =>
      app.inject({
        method: 'GET',
        url,
        headers: {
          cookie: opts.cookie ?? guest,
          ...(opts.from ? { 'x-forwarded-for': opts.from } : {}),
        },
      }),
  };
}

// the part of an answer that must not tell the state of an address: the status, the body and the
// headers, without the ones that count or date the request itself
const VARYING_HEADERS = new Set(['date', 'x-ratelimit-remaining', 'x-ratelimit-reset']);

export function publicAnswer(res: LightMyRequestResponse) {
  return {
    status: res.statusCode,
    body: res.body,
    headers: Object.fromEntries(
      Object.entries(res.headers).filter(([name]) => !VARYING_HEADERS.has(name)),
    ),
  };
}

// an error answer without the id of the request, which differs by request
export function errorAnswer(res: LightMyRequestResponse) {
  const { reqId: _reqId, ...rest } = res.json() as Record<string, unknown>;
  return { status: res.statusCode, ...rest };
}

// ---- rows read or arranged with an owner session ----

// the clock of the database, the one its timestamps are dated by (a column keeps no time zone, and the
// driver reads it in the zone of the machine, so a time of the row is held against this and not
// against Date.now())
export const databaseNow = () => inOwnerTx((db) => dbNow(db));

export const rowsOf = (email: string) => inOwnerTx((db) => subscriptionsOf(db, email));

export const journalOf = (email: string) => inOwnerTx((db) => journalOfAddress(db, email));

// the live row of an address, or null
export async function liveRowOf(email: string) {
  const rows = await rowsOf(email);
  return rows.find((row) => ['pending', 'active', 'paused_complaint'].includes(row.status)) ?? null;
}

export const isBlocked = (email: string) =>
  inOwnerTx(async (db) => {
    const rows = await db.rows(
      'select 1 from cartlify.newsletter_form_blocklist where "emailHmac" = $1',
      emailHmacOf(email),
    );
    return rows.length > 0;
  });

// a blocked address, the way the owner of the database or the person herself would leave it
export const blockAddress = (email: string) =>
  inOwnerTx(
    async (db) => {
      await insertRow(
        db,
        'newsletter_form_blocklist',
        blockRow({ emailHmac: emailHmacOf(email), byPerson: true }),
      );
    },
    { commit: true },
  );

export type Arranged = {
  id: number;
  email: string;
  // what the link "Manage the subscription" of a mail to this subscription carries
  manageToken: string;
  // what the unsubscribe button of the mail clients (List-Unsubscribe) of its mails carries
  unsubscribeToken: string;
  // what the link of confirmation carries; only for a request that waits
  confirmToken: string | null;
};

// A subscription made the way the routes would, but with a state a test needs at once (a paused
// one, one with a language): the tokens are the real ones, so the routes find it by them
export async function arrange(opts: SubscriptionOpts = {}): Promise<Arranged> {
  const email = opts.email ?? `arranged-${randomUUID()}@example.com`;
  const salt = makeManageSalt();
  const manageToken = manageTokenOf(salt);
  const unsubscribeToken = unsubscribeTokenOf(salt);
  const confirm = makeConfirmToken();
  const source = opts.source ?? 'form';
  const status = opts.status ?? 'active';

  const id = await inOwnerTx(
    (db) =>
      insertRow(
        db,
        'newsletter_subscriptions',
        subscriptionRow({
          ...opts,
          email,
          set: {
            manageSalt: salt,
            manageHash: manageHashOf(manageToken),
            unsubscribeHash: manageHashOf(unsubscribeToken),
            ...(source === 'form' ? { emailHmac: emailHmacOf(email) } : {}),
            ...(status === 'pending' ? { confirmHash: confirm.hash } : {}),
            ...opts.set,
          },
        }),
      ),
    { commit: true },
  );

  return {
    id,
    email,
    manageToken,
    unsubscribeToken,
    confirmToken: status === 'pending' ? confirm.token : null,
  };
}

// sets columns of the live row of an address (the marks of the last mails, the deadline of a link)
export async function setColumns(email: string, set: Record<string, unknown>): Promise<void> {
  const names = Object.keys(set);

  await inOwnerTx(
    (db) =>
      db.rows(
        `update cartlify.newsletter_subscriptions
         set ${names.map((name, index) => `"${name}" = $${index + 2}`).join(', ')}
         where email = $1 and status <> 'ended'`,
        email,
        ...Object.values(set),
      ),
    { commit: true },
  );
}

// the last mails to the address were sent long ago: the day between two mails to it has passed
export const passTheDay = (email: string) =>
  setColumns(email, { lastConfirmMailAt: utc(-2 * DAY), lastAlreadyMailAt: utc(-2 * DAY) });

// the link of a request that waits ran out its three days
export const expireLink = (email: string) => setColumns(email, { confirmExpiresAt: utc(-60_000) });

// takes away what the routes and the arrangements made for these addresses
export async function forget(emails: string[]): Promise<void> {
  if (emails.length === 0) return;

  const ids: number[] = [];
  for (const email of emails) ids.push(...(await rowsOf(email)).map((row) => row.id));

  await removeSubscriptionRows(ids, emails.map(emailHmacOf));
}

export const hashOfToken = (token: string) => hashToken(token);

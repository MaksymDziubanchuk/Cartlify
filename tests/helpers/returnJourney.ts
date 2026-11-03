import type { FastifyInstance } from 'fastify';

import { accessCookie } from './actors.js';
import { withCsrf, type Csrf } from './csrf.js';
import type { TestUser } from './factories.js';
import type { SentMail } from './mail.js';

// What each actor of a journey of a return sees and does, for the flows (tests/integration/flows):
// the buyer has the answers of their account and their mails, a visitor of the public form what
// they typed and the answers of the public routes, an admin the alerts, the lists and the cards.
// A step takes what it needs only from what its actor saw; the database is read at the end only,
// for what came of it. The test hands over the app and the token of the page as functions, because
// a test file makes them in beforeAll

// a signed-in user, or a visitor nobody knows (null)
export type Actor = TestUser | null;

export function journeyOf(app: () => FastifyInstance, csrf: () => Csrf) {
  const send = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    actor: Actor,
    payload?: Record<string, unknown>,
  ) =>
    app().inject({
      method,
      url,
      headers:
        method === 'GET'
          ? actor
            ? { cookie: accessCookie(actor) }
            : {}
          : actor
            ? withCsrf(csrf(), accessCookie(actor))
            : withCsrf(csrf()),
      ...(payload ? { payload } : {}),
    });

  return {
    get: (actor: Actor, url: string) => send('GET', url, actor),
    post: (actor: Actor, url: string, payload: Record<string, unknown> = {}) =>
      send('POST', url, actor, payload),
    put: (actor: Actor, url: string, payload: Record<string, unknown>) =>
      send('PUT', url, actor, payload),
    patch: (actor: Actor, url: string, payload: Record<string, unknown>) =>
      send('PATCH', url, actor, payload),
    del: (actor: Actor, url: string, payload: Record<string, unknown> = {}) =>
      send('DELETE', url, actor, payload),
  };
}

// the link of withdrawal in a mail, as the page of the frontend reads it: the order, the statement
// (the link of a parcel names one) and the code after the #
export function withdrawalLinkIn(mail: SentMail): {
  orderId: number;
  returnId: number | null;
  code: string;
} {
  const match =
    /\/orders\/(\d+)\/withdrawal(?:\?return=(\d+))?#([2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})/.exec(
      mail.text,
    );
  if (!match) throw new Error(`no link of withdrawal in the mail "${mail.subject}"`);
  return {
    orderId: Number(match[1]),
    returnId: match[2] ? Number(match[2]) : null,
    code: match[3]!,
  };
}

// the code of the statement a mail names in its text (Statement W42-2.)
export function statementCodeIn(mail: SentMail): string {
  const match = /Statement ([WR]\d+-\d+)\./.exec(mail.text);
  if (!match) throw new Error(`no code of a statement in the mail "${mail.subject}"`);
  return match[1]!;
}

// the mails to an address whose subject has the words, in the order they went
export const mailsTo = (mails: SentMail[], to: string, words: string) =>
  mails.filter(
    (mail) =>
      mail.to.some((one) => one.toLowerCase() === to.toLowerCase()) && mail.subject.includes(words),
  );

// the one mail to an address whose subject has the words; a step cannot go on without it
export function mailTo(mails: SentMail[], to: string, words: string): SentMail {
  const found = mailsTo(mails, to, words);
  if (found.length !== 1) {
    throw new Error(
      `${found.length} mails to ${to} with "${words}": ${mails.map((m) => m.subject).join('; ')}`,
    );
  }
  return found[0]!;
}

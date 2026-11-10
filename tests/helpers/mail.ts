import { randomBytes } from 'node:crypto';

import { isRealService } from './services.js';

const SENDGRID_SEND = 'https://api.sendgrid.com/v3/mail/send';
const SPAM_REPORTS = 'https://api.sendgrid.com/v3/suppression/spam_reports/';

// SendGrid in the integration tests (tests/setup/integration.mail.ts puts it in place):
// - a mock by default, it answers the way SendGrid does: 202 without a body for a mail it takes,
//   400 or 401 with its list of errors for a request it does not take;
// - the real service when the run names it (npm test -- service:sendgrid): every request of the
//   app goes to SendGrid in sandbox mode, SendGrid checks all of it and delivers nothing. A request
//   that cannot be put in sandbox mode never leaves the test.
// The app has two streams of mail, two accounts of SendGrid (the orders: SENDGRID_API_KEY and
// EMAIL_FROM; the newsletters: SENDGRID_NEWSLETTER_API_KEY and NEWSLETTER_EMAIL_FROM). The mock tells
// them apart by the key of the request and takes a mail only with the sender of its own stream, the
// way SendGrid refuses a sender its account has not verified. There is no test account of the
// newsletters: even when a run takes SendGrid for real, the requests of the newsletter stream
// (a mail, the clearing of a spam report) are answered by the mock and never leave the test
const realSendGrid = isRealService('sendgrid');

// a key SendGrid does not know: with it SendGrid itself refuses the mail
const REFUSED_KEY = 'SG.refused-by-the-test';

// a file the mail carries; text is its content read as utf-8
// an attachment with its content as sent (base64) and read as text
export type SentAttachment = {
  filename: string;
  type: string;
  disposition: string;
  text: string;
  content: string;
};

// the stream a request belongs to, by the key it carries
export type MailStream = 'orders' | 'newsletter';

export type SentMail = {
  stream: MailStream;
  to: string[];
  // the address and the name the mail is sent from
  from: string;
  fromName: string;
  // null when the mail asks for no reply address
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  attachments: SentAttachment[];
  categories: string[];
  // the headers the app added to the mail, the custom arguments that come back with its events, and
  // its tracking settings, as the request holds them
  headers: Record<string, string>;
  customArgs: Record<string, string>;
  tracking: Record<string, unknown>;
  // the answer of SendGrid (or of the mock): 2xx means it took the mail
  status: number;
  accepted: boolean;
  // the id it gave a mail it took (the header X-Message-Id of its answer), null when it took none
  messageId: string | null;
};

// the mails each watchMail or watchNewsletterMail of the running test collects; reset after every test
const watchers = new Map<SentMail[], MailStream>();
const ALL_STREAMS: MailStream[] = ['orders', 'newsletter'];
const refusing = new Set<MailStream>();

// how the mock answers the mails of the newsletter stream when a test scripts it (answerNewsletterMail)
let newsletterRule: NewsletterRule | null = null;
let newsletterCalls = 0;

// the requests to the list of spam reports each watchSpamReportClearing collects, and how the next
// ones are to fail
const clearingWatchers = new Set<ClearedSpamReport[]>();
let clearingBroken: 'refused' | 'unreachable' | null = null;

// the newsletter account, read when a request comes: the setup of the tests puts it in place first
const newsletterKey = (): string => process.env.SENDGRID_NEWSLETTER_API_KEY ?? '';
const newsletterSender = (): string => process.env.NEWSLETTER_EMAIL_FROM ?? '';

const streamOf = (init: RequestInit | undefined): MailStream => {
  const key = new Headers(init?.headers).get('authorization') ?? '';
  return newsletterKey() && key === `Bearer ${newsletterKey()}` ? 'newsletter' : 'orders';
};

// SendGrid gives every mail it takes an id, in the header X-Message-Id of its 202; the events of the
// webhook name the mail by it
let acceptedMails = 0;
const messageId = () => `mock-${++acceptedMails}.${randomBytes(6).toString('hex')}`;

const sendGridAnswer = (status: number, errors: string[] = []) =>
  errors.length
    ? new Response(
        JSON.stringify({ errors: errors.map((message) => ({ message, field: null, help: null })) }),
        { status, headers: { 'content-type': 'application/json' } },
      )
    : new Response(null, {
        status,
        ...(status >= 200 && status < 300 ? { headers: { 'x-message-id': messageId() } } : {}),
      });

type SendGridPayload = {
  personalizations?: { to?: { email?: string }[] }[];
  from?: { email?: string; name?: string };
  reply_to?: { email?: string };
  subject?: string;
  categories?: string[];
  headers?: Record<string, string>;
  custom_args?: Record<string, string>;
  tracking_settings?: Record<string, unknown>;
  content?: { type: string; value: string }[];
  attachments?: {
    content?: string;
    filename?: string;
    type?: string;
    disposition?: string;
  }[];
  mail_settings?: Record<string, unknown>;
};

const mailOf = (payload: SendGridPayload, stream: MailStream): SentMail => {
  const content = payload.content ?? [];
  return {
    stream,
    from: payload.from?.email ?? '',
    fromName: payload.from?.name ?? '',
    replyTo: payload.reply_to?.email ?? null,
    categories: payload.categories ?? [],
    headers: payload.headers ?? {},
    customArgs: payload.custom_args ?? {},
    tracking: payload.tracking_settings ?? {},
    to: (payload.personalizations ?? [])
      .flatMap((p) => (p.to ?? []).map((t) => t.email ?? ''))
      .filter(Boolean),
    subject: payload.subject ?? '',
    text: content.find((c) => c.type === 'text/plain')?.value ?? '',
    html: content.find((c) => c.type === 'text/html')?.value ?? '',
    attachments: (payload.attachments ?? []).map((file) => ({
      filename: file.filename ?? '',
      type: file.type ?? '',
      disposition: file.disposition ?? 'attachment',
      text: Buffer.from(file.content ?? '', 'base64').toString('utf8'),
      content: file.content ?? '',
    })),
    status: 0,
    accepted: false,
    messageId: null,
  };
};

// the mock: what SendGrid checks before it takes a mail, the key, the sender, the recipients,
// the subject and the content
function mockAnswer(payload: SendGridPayload, init: RequestInit | undefined): Response {
  const stream = streamOf(init);
  const mail = mailOf(payload, stream);
  const key = new Headers(init?.headers).get('authorization') ?? '';
  const errors = [
    ...(payload.from?.email ? [] : ['The from email does not contain a valid address.']),
    ...(mail.to.length ? [] : ['The to array is required for all personalization objects.']),
    ...(mail.subject ? [] : ['The subject is required.']),
    ...((payload.content ?? []).some((c) => c.value) ? [] : ['The content parameter is required.']),
    // what SendGrid asks of each file
    ...(payload.attachments ?? []).flatMap((file) => [
      ...(file.content ? [] : ['The attachment content is required.']),
      ...(file.filename ? [] : ['The attachment filename is required.']),
    ]),
  ];

  return !/^Bearer \S+$/.test(key)
    ? sendGridAnswer(401, ['The provided authorization grant is invalid, expired, or revoked'])
    : refusing.has(stream)
      ? sendGridAnswer(401, ['Maximum credits exceeded'])
      : errors.length
        ? sendGridAnswer(400, errors)
        : (senderRefusal(stream, mail.from) ?? sendGridAnswer(202));
}

// SendGrid takes a mail only from a sender its account has verified: the newsletter account the
// sender of the newsletters, the orders account any other. A stream that sends from the other's
// address is refused, so a mix-up of the keys and the senders in the app shows in a test
function senderRefusal(stream: MailStream, from: string): Response | null {
  const ownSender =
    stream === 'newsletter' ? from === newsletterSender() : from !== newsletterSender();

  return ownSender
    ? null
    : sendGridAnswer(403, ['The from address does not match a verified Sender Identity.']);
}

// the real service: the same request in sandbox mode, with a key SendGrid refuses after refuseMail
function sandboxRequest(payload: SendGridPayload, init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  if (refusing.has('orders')) headers.set('authorization', `Bearer ${REFUSED_KEY}`);

  return {
    ...init,
    headers,
    body: JSON.stringify({
      ...payload,
      mail_settings: { ...payload.mail_settings, sandbox_mode: { enable: true } },
    }),
  };
}

// in place for the whole test file, by assignment and not jest.spyOn: restoreAllMocks of a test
// must not take it away. Every other request passes untouched
export function installSendGrid(): void {
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(SPAM_REPORTS)) return spamReportAnswer(url, init);
    if (url !== SENDGRID_SEND) return realFetch(input, init);

    let payload: SendGridPayload;
    try {
      payload = JSON.parse(String(init?.body)) as SendGridPayload;
    } catch {
      // no sandbox mode for a body that is not json: the request must not reach SendGrid
      throw new Error('the app sent SendGrid a body that is not json, the test kept it back');
    }

    // the newsletter account has no key in a test of the real service: the mock answers it, and the
    // orders stream with a sender of the other stream is refused before it leaves the test
    const stream = streamOf(init);
    const mismatched = senderRefusal(stream, payload.from?.email ?? '') !== null;

    // a test that scripts the newsletter stream decides what the mail gets: a status, or silence
    const scripted =
      stream === 'newsletter' && newsletterRule
        ? await newsletterRule(mailOf(payload, stream), newsletterCalls++)
        : undefined;
    if (scripted === 'unreachable') throw new TypeError('fetch failed');

    const res =
      scripted !== undefined && scripted !== null
        ? sendGridAnswer(scripted, scripted >= 400 ? ['scripted by the test'] : [])
        : realSendGrid && stream === 'orders' && !mismatched
          ? await realFetch(SENDGRID_SEND, sandboxRequest(payload, init))
          : mockAnswer(payload, init);

    const mail = {
      ...mailOf(payload, stream),
      status: res.status,
      accepted: res.ok,
      messageId: res.headers.get('x-message-id'),
    };
    watchers.forEach((watched, sent) => {
      if (watched === stream) sent.push(mail);
    });
    return res;
  }) as typeof fetch;
}

export function resetSendGrid(): void {
  watchers.clear();
  clearingWatchers.clear();
  refusing.clear();
  clearingBroken = null;
  newsletterRule = null;
  newsletterCalls = 0;
}

// a copy of every mail of the orders the app sends from now until the test ends
export function watchMail(): SentMail[] {
  const sent: SentMail[] = [];
  watchers.set(sent, 'orders');
  return sent;
}

// the same for the newsletter stream: the mails of the account of the newsletters
export function watchNewsletterMail(): SentMail[] {
  const sent: SentMail[] = [];
  watchers.set(sent, 'newsletter');
  return sent;
}

// What the newsletter stream's mail gets, decided by the test for each mail it sees until the test
// ends: a status (the mock answers with it: 202 takes the mail, 400 refuses it, 401 refuses the key,
// 429 and 500 are busy), 'unreachable' (no answer at all: the connection fails), or nothing, and the
// mock answers as it does by default. The rule gets the mail as the watcher records it and the number
// of mails it has seen (from 0); it may wait (a test holds a mail back to run two things at once)
export type NewsletterAnswer = number | 'unreachable' | undefined | void;
type NewsletterRule = (
  mail: SentMail,
  index: number,
) => NewsletterAnswer | Promise<NewsletterAnswer>;

export function answerNewsletterMail(rule: NewsletterRule): void {
  newsletterRule = rule;
  newsletterCalls = 0;
}

// SendGrid refuses every mail of the streams until the test ends (both when none is named): the mock
// the way it refuses an account without credits, the real service because the request carries a key
// it does not know
export function refuseMail(...streams: MailStream[]): void {
  (streams.length ? streams : ALL_STREAMS).forEach((stream) => refusing.add(stream));
}

// one call of the app to delete an address from the list of spam reports: the address as the path
// names it, the stream of the key it carried and the status the mock gave
export type ClearedSpamReport = { email: string; stream: MailStream; status: number };

// a copy of every such call the app makes from now until the test ends
export function watchSpamReportClearing(): ClearedSpamReport[] {
  const calls: ClearedSpamReport[] = [];
  clearingWatchers.add(calls);
  return calls;
}

// the clearing of a spam report fails until the test ends: SendGrid refuses it (500), or does not
// answer at all (no call is recorded, the connection fails)
export function breakSpamReportClearing(kind: 'refused' | 'unreachable'): void {
  clearingBroken = kind;
}

// DELETE /v3/suppression/spam_reports/{email}: 204 for the key of the newsletter account, which
// holds the list; the key of the orders account is another account's, refused. Never real: there is
// no test account of the newsletters
function spamReportAnswer(url: string, init: RequestInit | undefined): Response {
  if (clearingBroken === 'unreachable') throw new TypeError('fetch failed');

  const stream = streamOf(init);
  const status = clearingBroken === 'refused' ? 500 : stream === 'newsletter' ? 204 : 403;
  const email = decodeURIComponent(url.slice(SPAM_REPORTS.length));

  clearingWatchers.forEach((calls) => calls.push({ email, stream, status }));
  return status === 204
    ? new Response(null, { status })
    : sendGridAnswer(status, ['The request was not accepted.']);
}

// The link to a frontend page in the mail (the plain text part), split into what follows its ? and
// what follows its #, each read as parameters; null when the mail has no link to the page. The
// tokens of the newsletter pages, of the verification and of a password reset ride in the fragment
// (/web/login#token=..., /web/auth/reset#token=...), never in the query
export function linkParts(
  mail: SentMail,
  page: string,
): { query: URLSearchParams; fragment: URLSearchParams } | null {
  const match = new RegExp(
    `https?://[^\\s"'<>]+${page}(?:\\?([^\\s"'<>#]*))?(?:#([^\\s"'<>]*))?`,
  ).exec(mail.text);

  return match
    ? { query: new URLSearchParams(match[1] ?? ''), fragment: new URLSearchParams(match[2] ?? '') }
    : null;
}

// the parameters of the link to a frontend page in the mail, the query and the fragment together
// (the token and whatever rides with it, for example the newsletter=1 hint of a registration); null
// when the mail has no link to the page
export function linkParams(mail: SentMail, page: string): URLSearchParams | null {
  const parts = linkParts(mail, page);
  if (!parts) return null;

  return new URLSearchParams([...parts.query, ...parts.fragment]);
}

// the token of a link to a frontend page in the mail, wherever it sits (the query or the fragment)
export function linkToken(mail: SentMail, page: string): string | null {
  return linkParams(mail, page)?.get('token') ?? null;
}

// the token of the last mail with a link to the page; a test that needs one cannot go on without
// it, and a made-up token would let a check for a refused link pass for the wrong reason
export function mailedToken(mails: SentMail[], page: string): string {
  const mail = mails.at(-1);
  const token = mail ? linkToken(mail, page) : null;

  if (!token) throw new Error(`no mail with a ${page} link was sent`);
  return token;
}

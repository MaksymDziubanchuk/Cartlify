import { isRealService } from './services.js';

const SENDGRID_SEND = 'https://api.sendgrid.com/v3/mail/send';

// SendGrid in the integration tests (tests/setup/integration.mail.ts puts it in place):
// - a mock by default, it answers the way SendGrid does: 202 without a body for a mail it takes,
//   400 or 401 with its list of errors for a request it does not take;
// - the real service when the run names it (npm test -- service:sendgrid): every request of the
//   app goes to SendGrid in sandbox mode, SendGrid checks all of it and delivers nothing. A request
//   that cannot be put in sandbox mode never leaves the test
const realSendGrid = isRealService('sendgrid');

// a key SendGrid does not know: with it SendGrid itself refuses the mail
const REFUSED_KEY = 'SG.refused-by-the-test';

export type SentMail = {
  to: string[];
  subject: string;
  text: string;
  html: string;
  // the answer of SendGrid (or of the mock): 2xx means it took the mail
  status: number;
  accepted: boolean;
};

// the mails each watchMail of the running test collects; reset after every test
const watchers = new Set<SentMail[]>();
let refusing = false;

const sendGridAnswer = (status: number, errors: string[] = []) =>
  errors.length
    ? new Response(
        JSON.stringify({ errors: errors.map((message) => ({ message, field: null, help: null })) }),
        { status, headers: { 'content-type': 'application/json' } },
      )
    : new Response(null, { status });

type SendGridPayload = {
  personalizations?: { to?: { email?: string }[] }[];
  from?: { email?: string };
  subject?: string;
  content?: { type: string; value: string }[];
  mail_settings?: Record<string, unknown>;
};

const mailOf = (payload: SendGridPayload): SentMail => {
  const content = payload.content ?? [];
  return {
    to: (payload.personalizations ?? [])
      .flatMap((p) => (p.to ?? []).map((t) => t.email ?? ''))
      .filter(Boolean),
    subject: payload.subject ?? '',
    text: content.find((c) => c.type === 'text/plain')?.value ?? '',
    html: content.find((c) => c.type === 'text/html')?.value ?? '',
    status: 0,
    accepted: false,
  };
};

// the mock: what SendGrid checks before it takes a mail, the key, the sender, the recipients,
// the subject and the content
function mockAnswer(payload: SendGridPayload, init: RequestInit | undefined): Response {
  const mail = mailOf(payload);
  const key = new Headers(init?.headers).get('authorization') ?? '';
  const errors = [
    ...(payload.from?.email ? [] : ['The from email does not contain a valid address.']),
    ...(mail.to.length ? [] : ['The to array is required for all personalization objects.']),
    ...(mail.subject ? [] : ['The subject is required.']),
    ...((payload.content ?? []).some((c) => c.value) ? [] : ['The content parameter is required.']),
  ];

  return !/^Bearer \S+$/.test(key)
    ? sendGridAnswer(401, ['The provided authorization grant is invalid, expired, or revoked'])
    : refusing
      ? sendGridAnswer(401, ['Maximum credits exceeded'])
      : errors.length
        ? sendGridAnswer(400, errors)
        : sendGridAnswer(202);
}

// the real service: the same request in sandbox mode, with a key SendGrid refuses after refuseMail
function sandboxRequest(payload: SendGridPayload, init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  if (refusing) headers.set('authorization', `Bearer ${REFUSED_KEY}`);

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
    if (url !== SENDGRID_SEND) return realFetch(input, init);

    let payload: SendGridPayload;
    try {
      payload = JSON.parse(String(init?.body)) as SendGridPayload;
    } catch {
      // no sandbox mode for a body that is not json: the request must not reach SendGrid
      throw new Error('the app sent SendGrid a body that is not json, the test kept it back');
    }

    const res = realSendGrid
      ? await realFetch(SENDGRID_SEND, sandboxRequest(payload, init))
      : mockAnswer(payload, init);

    const mail = { ...mailOf(payload), status: res.status, accepted: res.ok };
    watchers.forEach((sent) => sent.push(mail));
    return res;
  }) as typeof fetch;
}

export function resetSendGrid(): void {
  watchers.clear();
  refusing = false;
}

// a copy of every mail the app sends from now until the test ends
export function watchMail(): SentMail[] {
  const sent: SentMail[] = [];
  watchers.add(sent);
  return sent;
}

// SendGrid refuses every mail until the test ends: the mock the way it refuses an account without
// credits, the real service because the request carries a key it does not know
export function refuseMail(): void {
  refusing = true;
}

// the token of a link to a frontend page in the mail, for example /web/login?token=...
export function linkToken(mail: SentMail, page: string): string | null {
  const match = new RegExp(`https?://[^\\s"'<>]+${page}\\?token=([^\\s"'<>&]+)`).exec(mail.text);
  return match ? decodeURIComponent(match[1]!) : null;
}

// the token of the last mail with a link to the page; a test that needs one cannot go on without
// it, and a made-up token would let a check for a refused link pass for the wrong reason
export function mailedToken(mails: SentMail[], page: string): string {
  const mail = mails.at(-1);
  const token = mail ? linkToken(mail, page) : null;

  if (!token) throw new Error(`no mail with a ${page} link was sent`);
  return token;
}

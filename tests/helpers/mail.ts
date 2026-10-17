import { it, jest } from '@jest/globals';

const SENDGRID_SEND = 'https://api.sendgrid.com/v3/mail/send';

export type SentMail = {
  to: string[];
  subject: string;
  text: string;
  html: string;
  // sandbox mode: SendGrid checks the request and delivers nothing
  sandbox: boolean;
  // SendGrid's answer; 2xx means it accepted the request
  status: number | undefined;
};

// lets mail requests go to SendGrid for real and keeps a copy of each; the tests expect the app
// to send in sandbox mode, so nothing reaches a mailbox. Every other request passes untouched
export function watchMail(): SentMail[] {
  const realFetch = globalThis.fetch;
  const sent: SentMail[] = [];

  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== SENDGRID_SEND) return realFetch(input, init);

    const payload = JSON.parse(String(init?.body ?? '{}'));
    const content: { type: string; value: string }[] = payload.content ?? [];
    const mail: SentMail = {
      to: (payload.personalizations ?? []).flatMap((p: { to: { email: string }[] }) =>
        p.to.map((t) => t.email),
      ),
      subject: payload.subject ?? '',
      text: content.find((c) => c.type === 'text/plain')?.value ?? '',
      html: content.find((c) => c.type === 'text/html')?.value ?? '',
      sandbox: payload.mail_settings?.sandbox_mode?.enable === true,
      status: undefined,
    };
    sent.push(mail);

    const res = await realFetch(input, init);
    mail.status = res.status;
    return res;
  });

  return sent;
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

  if (!token) {
    throw new Error(`no mail with a ${page} link was sent: is the SendGrid sandbox set up?`);
  }
  return token;
}

// the tests that need a mail to go through SendGrid: the SendGrid trial ran out and the account
// refuses even sandbox requests, so they are skipped until a working account is set up;
// then this becomes `it` again (see CLAUDE.md, SendGrid)
export const itWithMail = it.skip;

import type { FastifyBaseLogger } from 'fastify';

import type { Provider } from '../provider.js';

import type { MailProviderName } from './names.js';

// The two streams of mail of the app, each with its own account at the provider, its key and its
// sender: the mails of the orders and of the accounts (orders), and the newsletters (newsletter),
// so the complaints about newsletters never touch the mails of the orders
export type MailStream = 'orders' | 'newsletter';

export type MailParty = { email: string; name: string };

// a file that goes with a mail, its content in base64
export type MailAttachment = { content: string; type: string; filename: string };

// a mail as the app makes it; the provider sends it as it is. The provider never tracks the
// opening of a mail or its links, and never adds a footer: the links of the mails are the app's
export type OutgoingMail = {
  to: string;
  from: MailParty;
  // where the answers go; none: the answers go to an address that drops them
  replyTo?: MailParty;
  subject: string;
  text: string;
  html: string;
  attachments?: readonly MailAttachment[];
  // headers of the mail itself (List-Unsubscribe and the like): names of letters, digits and
  // hyphens, values on one line
  headers?: Readonly<Record<string, string>>;
  // what comes back with every event the provider reports about the mail, as text
  tags?: Readonly<Record<string, string>>;
  // the group the provider counts the mail in, in its statistics
  category?: string;
};

// The errors a provider throws for a mail it did not take (InternalError, the reason in
// details.reason): it refused it, with details.failure saying whose fault it is (refused: the mail
// itself, it will never be taken; account: the key or the account of the stream; busy: the provider
// cannot take it now), or it gave no answer at all. The answer of the provider, which may name the
// address, stays in the cause, never in the details
export const MAIL_PROVIDER_REFUSED = 'MAIL_PROVIDER_REFUSED';
export const MAIL_PROVIDER_UNREACHABLE = 'MAIL_PROVIDER_UNREACHABLE';
// the stream has no key of the provider: a fault of the server, details.stream names the stream
export const MAIL_PROVIDER_NOT_CONFIGURED = 'MAIL_PROVIDER_NOT_CONFIGURED';

export type MailRefusal = 'refused' | 'account' | 'busy';

// What the provider reports about a mail of the newsletters that the app keeps:
// bounced - the address does not exist;
// dropped - the mail did not arrive, for a reason that is not the address (the receiving server
//   refused the sender or the content, the provider did not send it);
// complained - the reader marked the mail as spam.
// A drop the provider made because it knows the address from before says so (dropReason): as one
// that bounced, or as one that complained
export type MailEventKind = 'bounced' | 'dropped' | 'complained';
export type MailDropReason = 'address_bounced' | 'address_complained';

export type MailEvent = {
  kind: MailEventKind;
  dropReason: MailDropReason | null;
  // what the mail carried (OutgoingMail.tags), as the provider gave it back
  tags: Readonly<Record<string, unknown>>;
};

// a batch of events read: the events the app keeps, in the order the provider sent them; how many
// were of a kind the app does not keep (delivered, opened, ...), and how many were no event at all
export type MailEventsReading = { events: MailEvent[]; ignored: number; invalid: number };

// What a request to the webhook of the provider is, checked before its body is read:
// valid - the provider sent it, and it is fresh;
// missing - it carries no signature;
// unavailable - the server has no usable key to check it with (a fault of the server, not of the
//   request: nothing is taken as signed);
// invalid - the signature does not hold, or the request is too old or from the future.
// The reason is for the log only
export type MailWebhookCheck =
  | { verdict: 'valid' }
  | { verdict: 'missing' }
  | { verdict: 'unavailable'; reason: string }
  | { verdict: 'invalid'; reason: string };

// the webhook a provider reports the events of the mails of the newsletters to, under
// /api/newsletters/<name>/webhook
export type MailWebhook = {
  // the biggest body a batch of its events takes, in bytes
  bodyLimit: number;
  // the headers of a request: an inline json schema, with the ones it cannot go without required
  headers: Readonly<Record<string, unknown>>;
  // how the provider posts and signs, for the description of the route
  description: string;
  check(request: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    rawBody: Buffer;
  }): MailWebhookCheck;
  // the events of a body that was signed and is json; null when it is no batch of events
  readEvents(body: unknown): MailEventsReading | null;
};

// what the rest of the app asks of the mail provider. How it does it is its own: its requests, its
// accounts, its signatures and the words of its events stay in its folder
export interface MailProvider extends Provider<MailProviderName> {
  // the stream has what the provider needs to send (its key)
  isConfigured(stream: MailStream): boolean;
  // sends a mail of the stream; the id the provider gave it, which its events name it by. Throws
  // the errors above, MAIL_PROVIDER_NOT_CONFIGURED when the stream has no key
  send(stream: MailStream, mail: OutgoingMail): Promise<{ messageId?: string }>;
  // takes an address off the list of complaints of the newsletter stream: while it is there the
  // provider drops every mail to it. True when it is off (taken off, or never there), false when it
  // could not be done; never throws, the warning in the log names no address
  clearComplaint(email: string, log: Pick<FastifyBaseLogger, 'warn'>): Promise<boolean>;
  webhook: MailWebhook;
}

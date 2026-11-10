import { ENV_FOLDER } from '@utils/cloudinary.util.js';
import { MAX_ID } from '@schemas/idPathParam.js';

// The two ends of what comes back with the events of SendGrid. Every mail of the newsletters carries
// custom arguments, and SendGrid puts them on the same level as its own fields in each event it
// reports: the campaign and the recipient the mail was made for, and the environment that sent it.
// Never an address or a token, SendGrid keeps them in its logs.
//
// The Event Webhooks of dev and prod hear every event of the account (a shared account is how the
// shop runs in development): the mails of the orders, which carry none of the arguments, and the
// mails of the other environment, whose recipients are numbered from 1 in their own database. So an
// event counts only when it is of a kind the app keeps and carries all three arguments, with the
// environment of this one.

const CAMPAIGN = 'campaignId';
const RECIPIENT = 'recipientId';
const ENVIRONMENT = 'environment';

// the arguments a mail of a campaign is sent with, as text (SendGrid takes strings only); the
// environment is the one the Cloudinary folders are named by: prod, test, dev for anything else
export const customArgsOf = (campaignId: number, recipientId: number): Record<string, string> => ({
  [CAMPAIGN]: String(campaignId),
  [RECIPIENT]: String(recipientId),
  [ENVIRONMENT]: ENV_FOLDER,
});

// what the database knows how to apply (newsletter_apply_event)
export type MailEventKind = 'bounce' | 'dropped' | 'spamreport';

// `reason` is why SendGrid dropped the mail (its field "reason", only on a drop, only when it is
// text): the database decides what it means for the subscription
export type MailEventToApply = { recipientId: number; event: MailEventKind; reason?: string };

// the longest reason handed on: the reasons SendGrid gives are a few words, and the database compares
// them whole, so a longer text means nothing to it
const REASON_MAX_LENGTH = 200;

export type ReadMailEvents = {
  // the events to apply, in the order SendGrid sent them
  toApply: MailEventToApply[];
  // events of a kind the app does not keep (delivered, open, click, deferred, ...)
  ignored: number;
  // events of a kind it keeps that are not of a mail of this environment, and items that are no
  // events at all
  skipped: number;
};

const KEPT = new Set<string>(['bounce', 'dropped', 'spamreport']);

// the reason of a drop: the text SendGrid wrote, without the spaces around it, cut to a sane length;
// nothing when it is missing, no text or only spaces
const reasonOf = (event: Record<string, unknown>): string | null => {
  if (typeof event.reason !== 'string') return null;

  const reason = event.reason.trim().slice(0, REASON_MAX_LENGTH).trim();
  return reason === '' ? null : reason;
};

// an id of the database: a whole number from 1 to the biggest an integer column holds, written the
// plain way (no sign, no fraction, no zero in front, no spaces)
const idOf = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return null;

  const id = Number(value);
  return id <= MAX_ID ? id : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// What the app does with an event of a kind it keeps:
// - a bounce ends the subscription (the address does not exist);
// - a block, which SendGrid reports as a bounce of the type "blocked", is the receiving server
//   refusing the mail for a reason that is not the address (the sender, the content), so it is
//   told as a drop: the mail did not arrive, the subscription stays;
// - a drop and a spam report are what they say; a drop that says why (the reason) lets the database
//   treat the address as one that bounced or that reported spam before (readMailEvents).
function kindOf(event: Record<string, unknown>, name: MailEventKind): MailEventKind {
  return name === 'bounce' && event.type === 'blocked' ? 'dropped' : name;
}

export function readMailEvents(
  items: readonly unknown[],
  environment: string = ENV_FOLDER,
): ReadMailEvents {
  const read: ReadMailEvents = { toApply: [], ignored: 0, skipped: 0 };

  for (const item of items) {
    if (!isRecord(item)) {
      read.skipped += 1;
      continue;
    }

    const name = item.event;
    if (typeof name !== 'string' || !KEPT.has(name)) {
      read.ignored += 1;
      continue;
    }

    const campaignId = idOf(item[CAMPAIGN]);
    const recipientId = idOf(item[RECIPIENT]);

    if (campaignId === null || recipientId === null || item[ENVIRONMENT] !== environment) {
      read.skipped += 1;
      continue;
    }

    // only the drop SendGrid reports as a drop says why: the reason of a bounce is the text of the
    // receiving server, and a block (a bounce made a drop) has that text too
    const reason = name === 'dropped' ? reasonOf(item) : null;

    read.toApply.push({
      recipientId,
      event: kindOf(item, name as MailEventKind),
      ...(reason === null ? {} : { reason }),
    });
  }

  return read;
}

import { ENVIRONMENT_NAME } from '@config/environment.js';
import { MAX_ID } from '@schemas/idPathParam.js';

import type { MailEventKind, MailEventsReading, MailDropReason } from '@providers/mail/index.js';

// The two ends of what comes back with the events of the mail provider. Every mail of the newsletters
// carries tags, which the provider gives back with each event it reports: the campaign and the
// recipient the mail was made for, and the environment that sent it. Never an address or a token,
// the provider keeps them in its logs.
//
// The webhooks of dev and prod hear every event of the account (a shared account is how the shop
// runs in development): the mails of the orders, which carry none of the tags, and the mails of the
// other environment, whose recipients are numbered from 1 in their own database. So an event counts
// only when it carries all three tags, with the environment of this one.

const CAMPAIGN = 'campaignId';
const RECIPIENT = 'recipientId';
const ENVIRONMENT = 'environment';

// the tags a mail of a campaign is sent with, as text; the environment is ENVIRONMENT_NAME: prod,
// test, dev for anything else
export const mailTagsOf = (campaignId: number, recipientId: number): Record<string, string> => ({
  [CAMPAIGN]: String(campaignId),
  [RECIPIENT]: String(recipientId),
  [ENVIRONMENT]: ENVIRONMENT_NAME,
});

// what the database applies (newsletter_apply_event): the kind of the event, and for a drop the
// reason the provider gave, when it is one the database knows
export type MailEventToApply = {
  recipientId: number;
  event: MailEventKind;
  dropReason: MailDropReason | null;
};

export type ReadMailEvents = {
  // the events to apply, in the order the provider sent them
  toApply: MailEventToApply[];
  // events of a kind the app does not keep (delivered, opened, ...)
  ignored: number;
  // events of a kind it keeps that are not of a mail of this environment, and items that are no
  // events at all
  skipped: number;
};

// an id of the database: a whole number from 1 to the biggest an integer column holds, written the
// plain way (no sign, no fraction, no zero in front, no spaces)
const idOf = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return null;

  const id = Number(value);
  return id <= MAX_ID ? id : null;
};

export function readMailEvents(
  reading: MailEventsReading,
  environment: string = ENVIRONMENT_NAME,
): ReadMailEvents {
  const read: ReadMailEvents = { toApply: [], ignored: reading.ignored, skipped: reading.invalid };

  for (const { kind, dropReason, tags } of reading.events) {
    const campaignId = idOf(tags[CAMPAIGN]);
    const recipientId = idOf(tags[RECIPIENT]);

    if (campaignId === null || recipientId === null || tags[ENVIRONMENT] !== environment) {
      read.skipped += 1;
      continue;
    }

    read.toApply.push({ recipientId, event: kind, dropReason });
  }

  return read;
}

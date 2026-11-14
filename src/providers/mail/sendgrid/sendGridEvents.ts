import type { MailDropReason, MailEvent, MailEventKind, MailEventsReading } from '../types.js';

// The events of the Event Webhook of SendGrid in our words. A batch is a JSON list of events; the
// custom arguments a mail was sent with (its tags) come back on the same level as the fields of
// SendGrid itself, so an event is its own bag of tags. Of the kinds SendGrid reports, three are
// kept:
// - bounce: the address does not exist (bounced). A block, which SendGrid reports as a bounce of the
//   type "blocked", is the receiving server refusing the mail for a reason that is not the address
//   (the sender, the content): it is a drop, the mail did not arrive;
// - dropped: SendGrid did not send the mail (dropped). Its field reason says why: an address it
//   knows as bounced ("Bounced Address") or as one that reported spam ("Spam Reporting Address"),
//   read whatever the case and the spaces around it; any other reason is none of ours;
// - spamreport: the reader marked the mail as spam (complained).
// Every other kind (processed, delivered, deferred, open, click, unsubscribe, group events) is
// ignored, an item that is no object is no event.

const KEPT: Readonly<Record<string, MailEventKind>> = {
  bounce: 'bounced',
  dropped: 'dropped',
  spamreport: 'complained',
};

const DROP_REASONS: Readonly<Record<string, MailDropReason>> = {
  'bounced address': 'address_bounced',
  'spam reporting address': 'address_complained',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// only the drop SendGrid reports as a drop says why: the reason of a bounce is the text of the
// receiving server, and a block (a bounce made a drop) has that text too
const dropReasonOf = (name: string, event: Record<string, unknown>): MailDropReason | null =>
  name === 'dropped' && typeof event.reason === 'string'
    ? (DROP_REASONS[event.reason.trim().toLowerCase()] ?? null)
    : null;

export function readSendGridEvents(body: unknown): MailEventsReading | null {
  if (!Array.isArray(body)) return null;

  const reading: MailEventsReading = { events: [], ignored: 0, invalid: 0 };

  for (const item of body) {
    if (!isRecord(item)) {
      reading.invalid += 1;
      continue;
    }

    const name = item.event;
    const kept = typeof name === 'string' && Object.hasOwn(KEPT, name) ? KEPT[name]! : null;
    if (!kept) {
      reading.ignored += 1;
      continue;
    }

    const event: MailEvent = {
      kind: name === 'bounce' && item.type === 'blocked' ? 'dropped' : kept,
      dropReason: dropReasonOf(name as string, item),
      tags: item,
    };
    reading.events.push(event);
  }

  return reading;
}

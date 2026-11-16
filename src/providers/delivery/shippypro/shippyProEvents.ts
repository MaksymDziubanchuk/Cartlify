import type { DeliveryEvent, DeliveryEventKind } from '../types.js';

// The events of the webhook of ShippyPro in our words. It posts one event a request:
// ORDER_SHIPPED - the label was made; ORDER_ERROR - it was not; TRACKING_UPDATE - what the carrier
// reported, with a code of a closed list the same for every carrier (code 0-6, extendedCode with
// four digits). Only what the shop acts on is kept: the carrier has the parcel, it was delivered,
// it goes back, it is back, it is lost. Every other code (data received, the exceptions of the
// 5xxx that are none of these, a code it could not map) is dropped

// extendedCode: 2000-4999 the carrier has the parcel (picked up, on the way, at the courier, at a
// point, a failed attempt); 6000 delivered, 6900 marked delivered by hand; 5630 returning to the
// sender, 5640 returned; 5330 lost
function kindOfExtended(code: number): DeliveryEventKind | null {
  if (code >= 2000 && code <= 4999) return 'collected';
  if (code === 6000 || code === 6900) return 'delivered';
  if (code === 5630) return 'returning';
  if (code === 5640) return 'returned';
  if (code === 5330) return 'lost';
  return null;
}

// code, when the event has no extendedCode: 2 on the way, 3 at the courier, 4 a failed attempt,
// 6 delivered
function kindOfCode(code: number): DeliveryEventKind | null {
  if (code === 2 || code === 3 || code === 4) return 'collected';
  if (code === 6) return 'delivered';
  return null;
}

const text = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const numberOf = (value: unknown): number | null => {
  const raw = text(value);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
};

// the date of an event, seconds since the epoch; the time it came when there is none, or none a
// date of an event can be (no date at all, or a year of five digits: milliseconds sent as seconds)
function dateOf(value: unknown, received: Date): Date {
  const seconds = numberOf(value);
  if (seconds === null) return received;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) || at.getUTCFullYear() > 9999 ? received : at;
}

// the events of one body: one event of ours, none for an event the shop does not act on, null for a
// body that is no event of ShippyPro (no name of an event, or no parcel)
export function readShippyProEvents(body: unknown, received = new Date()): DeliveryEvent[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const event = body as Record<string, unknown>;
  const name = text(event.Event);
  const parcelId = text(event.OrderID);
  if (!name || !parcelId || !/^\d+$/.test(parcelId)) return null;

  let kind: DeliveryEventKind | null;
  let at = received;

  switch (name) {
    case 'ORDER_SHIPPED':
      kind = 'created';
      break;
    case 'ORDER_ERROR':
      kind = 'failed';
      break;
    case 'TRACKING_UPDATE': {
      const extended = numberOf(event.extendedCode);
      const code = numberOf(event.code);
      kind = extended !== null ? kindOfExtended(extended) : code !== null ? kindOfCode(code) : null;
      at = dateOf(event.date, received);
      break;
    }
    default:
      kind = null;
  }

  if (!kind) return [];

  return [
    {
      parcelId,
      reference: text(event.TransactionID),
      kind,
      at,
      trackingNumber: text(event.TrackingNumber) ?? text(event.tracking),
      // its list of codes does not tell a refusal of the recipient from a parcel nobody collected
      refused: false,
    },
  ];
}

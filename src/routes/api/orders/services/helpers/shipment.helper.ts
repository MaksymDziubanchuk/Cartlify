import { BadRequestError } from '@utils/errors.js';

import type { ShipmentInputDto } from 'types/dto/orders.dto.js';

// a send as it is written to order_shipments
export type ShipmentData = {
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  cost: number | null;
};

// a text of a send as the admin wrote it: not sent is none, sent is the text without the spaces
// around it, and sent as spaces only is a mistake, not none
function textOf(value: string | null | undefined, invalidCode: string): string | null {
  if (value === undefined || value === null) return null;

  const text = value.trim();
  if (!text) throw new BadRequestError(invalidCode);

  return text;
}

// what a send needs to hold together: a number and a link each name their carrier, so the buyer
// sees whose tracking it is; a link may come without a number. The request schema holds the
// lengths, the form of the link (https) and of the cost; the database holds the same rules for any
// other write
export function buildShipmentData(input: ShipmentInputDto | undefined): ShipmentData {
  const carrier = textOf(input?.carrier, 'SHIPMENT_CARRIER_INVALID');
  const trackingNumber = textOf(input?.trackingNumber, 'SHIPMENT_NUMBER_INVALID');
  const trackingUrl = input?.trackingUrl?.trim() || null;

  if ((trackingNumber || trackingUrl) && !carrier) {
    throw new BadRequestError('SHIPMENT_CARRIER_REQUIRED');
  }

  return { carrier, trackingNumber, trackingUrl, cost: input?.cost ?? null };
}

// a send in the form the admin log keeps it
export const shipmentLogOf = (send: {
  id: number;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  cost: unknown;
}) => ({
  id: send.id,
  carrier: send.carrier,
  trackingNumber: send.trackingNumber,
  trackingUrl: send.trackingUrl,
  cost: send.cost === null || send.cost === undefined ? null : Number(send.cost),
});

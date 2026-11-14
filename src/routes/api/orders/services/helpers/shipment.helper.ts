import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { BadRequestError } from '@utils/errors.js';

import type { Prisma } from '@prisma/client';
import type { ShipmentInputDto } from 'types/dto/orders.dto.js';

// a send as the admin gives it: what order_shipments keeps of it, and what the shop pays the
// carrier, which is a line of the money journal (recordShipmentCost), none until it is known
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

// what the shop pays the carrier for each of the sends: the sum of its lines in the money journal
// (the first cost and its corrections), by the id of the send; a send no line names is not in it
export async function shipmentCostsOf(
  db: Prisma.TransactionClient,
  shipmentIds: number[],
): Promise<Map<number, number>> {
  if (shipmentIds.length === 0) return new Map();

  const sums = await db.moneyLog.groupBy({
    by: ['orderShipmentId'],
    // what the shop paid the carrier, not money a carrier paid the shop (money.received)
    where: {
      orderShipmentId: { in: shipmentIds },
      purpose: 'shipping',
      event: { not: 'money.received' },
    },
    _sum: { amount: true },
  });

  // a line is below 0, money from the shop; 0 stays 0, never -0
  return new Map(
    sums.map((one) => [one.orderShipmentId!, -decimalToNumber(one._sum.amount ?? 0) || 0]),
  );
}

// writes what the shop pays the carrier for a send, in the name of the actor of the transaction
// (db/05 record_order_shipment_cost): the first cost above 0 is a line, a different one later a
// line of the difference; the same cost, or 0 while none is written, writes nothing. The cost
// before the call (none while no line names the send) and whether a line was written
export async function recordShipmentCost(
  db: Prisma.TransactionClient,
  shipmentId: number,
  cost: number,
): Promise<{ oldCost: number | null; changed: boolean }> {
  const [row] = await db.$queryRaw<{ result: { oldCost: string | null; changed: boolean } }[]>`
    select cartlify.record_order_shipment_cost(${shipmentId}::int, ${cost}::numeric) as result`;

  const oldCost = row!.result.oldCost;
  return { oldCost: oldCost === null ? null : Number(oldCost), changed: row!.result.changed };
}

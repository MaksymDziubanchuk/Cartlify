import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError, InternalError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';

import type { RecordReturnShipmentDto, ReturnDto } from 'types/dto/returns.dto.js';

// An admin or root records a parcel the shop paid to carry the goods of a statement back from the
// buyer: a label the shop bought, or the carrier of the buyer that the shop paid back outside the
// app. The time is the admin's to give (never of the future, never before the order was paid); the
// cost may be written later, and counts in the period of that time. The answer is the card
export async function recordReturnShipment({
  actorId,
  actorRole,
  returnId,
  carrier,
  trackingNumber,
  trackingUrl,
  cost,
  shippedAt,
}: RecordReturnShipmentDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);

  const at = new Date(shippedAt);
  if (Number.isNaN(at.getTime())) throw new BadRequestError('RETURN_SHIPMENT_TIME_INVALID');

  // a number and a link of a parcel belong to its carrier (db/06 says so too)
  if ((trackingNumber?.trim() || trackingUrl?.trim()) && !carrier?.trim()) {
    throw new BadRequestError('RETURN_SHIPMENT_CARRIER_REQUIRED');
  }

  try {
    return await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });

      const [row] = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
        select cartlify.record_return_shipment(
          ${returnId}::int,
          ${carrier ?? null}::text,
          ${trackingNumber ?? null}::text,
          ${trackingUrl ?? null}::text,
          ${cost ?? null}::numeric,
          (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        ) as id
      `);
      if (!row) throw new InternalError({ reason: 'RETURN_SHIPMENT_NOT_MADE' });

      const card = await readReturnCard(db, returnId, actorRole);
      if (!card) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_SHIPMENT' });

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: card.orderId,
        action: 'OTHER',
        event: 'return.shipment_record',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          {
            field: 'shipment',
            old: null,
            new: {
              shipmentId: row.id,
              carrier: carrier ?? null,
              trackingNumber: trackingNumber ?? null,
              trackingUrl: trackingUrl ?? null,
              cost: cost ?? null,
              shippedAt: at.toISOString(),
            },
          },
        ],
      });

      // the card again: its history ends with the line just written
      return (await readReturnCard(db, returnId, actorRole))!;
    });
  } catch (err) {
    throw returnErrorOf(err);
  }
}

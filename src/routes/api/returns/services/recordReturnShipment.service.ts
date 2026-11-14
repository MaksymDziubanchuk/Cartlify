import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError, InternalError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';
import { sendReturnSentBackEmail } from './helpers/returnMoneyMail.helper.js';

import type { RecordReturnShipmentDto, ReturnDto } from 'types/dto/returns.dto.js';

// An admin or root records a parcel of a statement. To the shop: the parcel the goods come back in,
// one a statement while goods of it are on their way (a label the shop bought, or the carrier of the
// buyer). To the buyer: goods the shop did not accept go back; the parcel names the rows and the
// units it carries, and the buyer is mailed its carrier and number once it is kept. The time is the
// admin's to give (never of the future, never before the order was paid); the cost may be written
// later, and counts in the period it is written. The answer is the card
export async function recordReturnShipment({
  actorId,
  actorRole,
  returnId,
  direction,
  items,
  carrier,
  trackingNumber,
  trackingUrl,
  cost,
  shippedAt,
  log,
}: RecordReturnShipmentDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);

  const at = new Date(shippedAt);
  if (Number.isNaN(at.getTime())) throw new BadRequestError('RETURN_SHIPMENT_TIME_INVALID');

  // a number and a link of a parcel belong to its carrier (db/06 says so too)
  if ((trackingNumber?.trim() || trackingUrl?.trim()) && !carrier?.trim()) {
    throw new BadRequestError('RETURN_SHIPMENT_CARRIER_REQUIRED');
  }

  // a parcel to the buyer names the rows it carries; the parcel to the shop carries the statement
  if (direction === 'to_shop' && items !== undefined) {
    throw new BadRequestError('RETURN_ITEMS_NOT_ALLOWED');
  }
  if (direction === 'to_buyer' && !items?.length) {
    throw new BadRequestError('RETURN_ITEMS_REQUIRED');
  }

  let recorded: { card: ReturnDto; shipmentId: number };
  try {
    recorded = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });

      const time = Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
      const [row] =
        direction === 'to_buyer'
          ? await db.$queryRaw<{ id: number }[]>(Prisma.sql`
              select cartlify.send_return_goods_back(
                ${returnId}::int,
                ${JSON.stringify(items)}::jsonb,
                ${carrier ?? null}::text,
                ${trackingNumber ?? null}::text,
                ${trackingUrl ?? null}::text,
                ${cost ?? null}::numeric,
                ${time}
              ) as id
            `)
          : await db.$queryRaw<{ id: number }[]>(Prisma.sql`
              select cartlify.record_return_shipment(
                ${returnId}::int,
                ${carrier ?? null}::text,
                ${trackingNumber ?? null}::text,
                ${trackingUrl ?? null}::text,
                ${cost ?? null}::numeric,
                ${time}
              ) as id
            `);
      if (!row) throw new InternalError({ reason: 'RETURN_SHIPMENT_NOT_MADE' });

      const card = await readReturnCard(db, returnId, actorRole);
      if (!card) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_SHIPMENT' });

      // the cost of the parcel is a line of the money journal (none for no cost or a cost of 0)
      const costLines = await db.moneyLog.findMany({
        where: { orderShipmentId: row.id },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      // the rows a parcel to the buyer carries, as the split left them
      const itemIds = card.parcels.find((parcel) => parcel.id === row.id)?.itemIds ?? [];

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: card.orderId,
        action: 'OTHER',
        event: 'return.shipment_record',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          ...(costLines.length
            ? [{ field: 'moneyLogIds', old: null, new: costLines.map((line) => line.id) }]
            : []),
          {
            field: 'shipment',
            old: null,
            new: {
              shipmentId: row.id,
              direction,
              ...(direction === 'to_buyer' ? { itemIds } : {}),
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
      return { card: (await readReturnCard(db, returnId, actorRole))!, shipmentId: row.id };
    });
  } catch (err) {
    throw returnErrorOf(err);
  }

  // the buyer is told of the goods on their way back to them once the parcel is kept
  if (direction === 'to_buyer') await sendReturnSentBackEmail(returnId, recorded.shipmentId, log);

  return recorded.card;
}

import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { InternalError, NotFoundError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';

import type { ReturnDto, SetReturnShipmentCostDto } from 'types/dto/returns.dto.js';

// An admin or root writes, or corrects, what the shop paid for a parcel back. The time of the parcel
// stays, so the cost goes to the period the parcel was sent in. The parcel has to be one of the
// statement in the path. The answer is the card
export async function setReturnShipmentCost({
  actorId,
  actorRole,
  returnId,
  shipmentId,
  cost,
}: SetReturnShipmentCostDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);

  try {
    return await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });

      // the parcel has to be one of this statement
      const mine = await db.returnShipment.count({ where: { id: shipmentId, returnId } });
      if (!mine) throw new NotFoundError('RETURN_SHIPMENT_NOT_FOUND');

      // the cost it had comes from the function, read under the lock of the order
      const [row] = await db.$queryRaw<{ done: { oldCost: string | null } }[]>(Prisma.sql`
        select cartlify.set_return_shipment_cost(${shipmentId}::int, ${cost}::numeric) as done
      `);
      if (!row) throw new InternalError({ reason: 'RETURN_SHIPMENT_COST_NOT_SET' });

      const card = await readReturnCard(db, returnId, actorRole);
      if (!card) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_SHIPMENT_COST' });

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: card.orderId,
        action: 'OTHER',
        event: 'return.shipment_cost',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          { field: 'shipmentId', old: null, new: shipmentId },
          {
            field: 'cost',
            old: row.done.oldCost === null ? null : Number(row.done.oldCost),
            new: cost,
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

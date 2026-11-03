import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { InternalError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';
import { sendReturnClosedEmail } from './helpers/returnMoneyMail.helper.js';

import type { ReceiveReturnItemsDto, ReturnDto } from 'types/dto/returns.dto.js';

// an admin or a root sets what became of the goods of the rows of a statement: all the results or
// none. The database splits a row whose units get a result in part, moves the stock and the batches
// of the units that come back, and closes the statement when every row has its result; the buyer is
// mailed then (the units that went back and those that did not)
export async function receiveReturnItems({
  actorId,
  actorRole,
  returnId,
  results,
  log,
}: ReceiveReturnItemsDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);

  let card: ReturnDto;
  try {
    card = await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRaw`
        select cartlify.receive_return_items(${returnId}::int, ${JSON.stringify(results)}::jsonb)
      `;

      const card = await readReturnCard(db, returnId, actorRole);
      if (!card) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_RECEIVE' });

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: card.orderId,
        action: 'OTHER',
        event: 'return.receive',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          { field: 'results', old: null, new: results },
        ],
      });

      // the card again: its history ends with the line just written
      return (await readReturnCard(db, returnId, actorRole))!;
    });
  } catch (err) {
    throw returnErrorOf(err);
  }

  if (card.closedAt) await sendReturnClosedEmail(returnId, log);

  return card;
}

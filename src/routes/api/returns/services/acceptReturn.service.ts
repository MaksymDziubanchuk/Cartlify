import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { InternalError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';

import type { AcceptReturnDto, ReturnDto } from 'types/dto/returns.dto.js';

// an admin or a root accepts a statement of the form without the code as the buyer's, once, after
// checking it outside the app (a letter to the email of the statement, the order): only then its
// goods and its money are handled, and the form may take another statement for the units left
export async function acceptReturn({
  actorId,
  actorRole,
  returnId,
}: AcceptReturnDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);

  try {
    return await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRaw`select cartlify.accept_return(${returnId}::int)`;

      const card = await readReturnCard(db, returnId, actorRole);
      if (!card) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_ACCEPT' });

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: card.orderId,
        action: 'OTHER',
        event: 'return.accept',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          { field: 'acceptedAt', old: null, new: card.acceptedAt },
        ],
      });

      // the card again: its history ends with the line just written
      return (await readReturnCard(db, returnId, actorRole))!;
    });
  } catch (err) {
    throw returnErrorOf(err);
  }
}

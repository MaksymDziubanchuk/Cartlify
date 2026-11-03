import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { InternalError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';

import type { ConfirmReturnProofDto, ReturnDto } from 'types/dto/returns.dto.js';

// an admin or a root confirms the proof the buyer sent the goods back, once; the admin may confirm
// it without a number from the buyer (a letter with the photos): the decision is theirs
export async function confirmReturnProof({
  actorId,
  actorRole,
  returnId,
}: ConfirmReturnProofDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);

  try {
    return await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      await db.$executeRaw`select cartlify.confirm_return_proof(${returnId}::int)`;

      const card = await readReturnCard(db, returnId, actorRole);
      if (!card) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_PROOF' });

      await writeAdminAuditLog(db, {
        actorId,
        actorRole,
        entityType: 'order',
        entityId: card.orderId,
        action: 'OTHER',
        event: 'return.proof_confirm',
        changes: [
          { field: 'returnId', old: null, new: returnId },
          { field: 'proofConfirmedAt', old: null, new: card.proof.confirmedAt },
        ],
      });

      // the card again: its history ends with the line just written
      return (await readReturnCard(db, returnId, actorRole))!;
    });
  } catch (err) {
    throw returnErrorOf(err);
  }
}

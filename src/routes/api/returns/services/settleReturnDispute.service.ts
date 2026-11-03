import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { BadRequestError, ForbiddenError, InternalError, NotFoundError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';
import { settleReturnDisputeIn } from './helpers/returnDispute.helper.js';
import { returnErrorOf } from './helpers/returnErrors.helper.js';

import type { ReturnDto, SettleReturnDisputeDto } from 'types/dto/returns.dto.js';

// root records the end of a dispute of the payment of the order of a statement at the bank: lost (the
// bank gave the buyer the money) or won (the money can be sent again). It settles every disputed
// row of the order: the dispute is of the payment, not of a statement
export async function settleReturnDispute({
  actorId,
  actorRole,
  returnId,
  outcome,
  note,
  at,
}: SettleReturnDisputeDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);
  if (actorRole !== 'ROOT') throw new ForbiddenError('FORBIDDEN_ROLE');

  const day = at === undefined ? undefined : new Date(at);
  if (day && Number.isNaN(day.getTime())) throw new BadRequestError('RETURN_OUTSIDE_AT_INVALID');

  try {
    return await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: actorRole });
      const statement = await db.orderReturn.findUnique({
        where: { id: returnId },
        select: { orderId: true },
      });
      if (!statement) throw new NotFoundError('RETURN_NOT_FOUND');

      await settleReturnDisputeIn(db, {
        orderId: statement.orderId,
        won: outcome === 'won',
        note,
        at: day,
        actor: { id: Number(actorId), role: actorRole },
      });

      const card = await readReturnCard(db, returnId, actorRole);
      if (!card) throw new InternalError({ reason: 'RETURN_NOT_FOUND_AFTER_DISPUTE' });
      return card;
    });
  } catch (err) {
    throw returnErrorOf(err);
  }
}

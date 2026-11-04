import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { NotFoundError } from '@utils/errors.js';

import { readReturnCard } from './helpers/returnCard.helper.js';

import type { GetReturnDto, ReturnDto } from 'types/dto/returns.dto.js';

// the card of a statement of withdrawal or of return, for an admin or a root
export async function getReturn({
  actorId,
  actorRole,
  returnId,
}: GetReturnDto): Promise<ReturnDto> {
  assertAdminActor(actorId, actorRole);

  const card = await prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: actorId, role: actorRole });
    return readReturnCard(db, returnId, actorRole);
  });
  if (!card) throw new NotFoundError('RETURN_NOT_FOUND');

  return card;
}

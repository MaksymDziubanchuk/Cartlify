import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { InternalError, NotFoundError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import { mapPartyRow, partySelect, usageOf } from './helpers/parties.helper.js';

import type { GetPartyDto, PartyDetailDto } from 'types/dto/parties.dto.js';

// a party of the directory with the number of products that name it
export async function getParty({
  actorId,
  actorRole,
  partyId,
}: GetPartyDto): Promise<PartyDetailDto> {
  assertAdminActor(actorId, actorRole);

  try {
    return await prisma.$transaction(async (tx) => {
      // the products taken out of the catalog are counted too, which an admin reads
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const row = await tx.party.findUnique({ where: { id: partyId }, select: partySelect });
      if (!row) throw new NotFoundError('PARTY_NOT_FOUND');

      const usage = (await usageOf(tx, [partyId])).get(partyId)!;
      return { ...mapPartyRow(row), usage };
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'PARTIES_GET_UNEXPECTED' }, err);
  }
}

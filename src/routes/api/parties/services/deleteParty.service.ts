import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { ConflictError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';

import { isForeignKeyViolation, partySelect, productsNaming } from './helpers/parties.helper.js';

import type { DeletePartyDto } from 'types/dto/parties.dto.js';
import type { MessageResponseDto } from 'types/common.js';

// takes a party out of the directory; a party a product names, as its manufacturer or its person
// in the EU, stays: 409 PARTY_IN_USE names some of the products and how many
export async function deleteParty({
  actorId,
  actorRole,
  partyId,
}: DeletePartyDto): Promise<MessageResponseDto> {
  assertAdminActor(actorId, actorRole);

  try {
    await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const party = await tx.party.findUnique({ where: { id: partyId }, select: partySelect });
      if (!party) throw new NotFoundError('PARTY_NOT_FOUND');

      const naming = await productsNaming(tx, partyId, { manufacturer: true, euResponsible: true });
      if (naming.total > 0) throw new ConflictError('PARTY_IN_USE', naming);

      await tx.party.delete({ where: { id: partyId } });

      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'party',
        entityId: partyId,
        action: 'OTHER',
        event: 'party.delete',
        changes: [
          { field: 'name', old: party.name, new: null },
          { field: 'address', old: party.address, new: null },
          { field: 'email', old: party.email, new: null },
          { field: 'country', old: party.country, new: null },
        ],
      });
    });

    return { message: 'Party deleted successfully.' };
  } catch (err) {
    if (isAppError(err)) throw err;

    // a product that named the party between the check and the delete: the key of the database holds
    if (isForeignKeyViolation(err)) throw new ConflictError('PARTY_IN_USE');

    throw new InternalError({ reason: 'PARTIES_DELETE_UNEXPECTED' }, err);
  }
}

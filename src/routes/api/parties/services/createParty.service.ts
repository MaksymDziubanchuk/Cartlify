import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { InternalError, isAppError } from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { normalizeParty } from '@helpers/party.js';

import { mapPartyRow, partyConflictOf, partySelect } from './helpers/parties.helper.js';

import type { CreatePartyDto, PartyDto } from 'types/dto/parties.dto.js';

// a manufacturer or a person responsible in the EU, new in the directory
export async function createParty({ actorId, actorRole, body }: CreatePartyDto): Promise<PartyDto> {
  assertAdminActor(actorId, actorRole);

  const values = normalizeParty(body, { path: '', required: true });

  try {
    const row = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      const created = await tx.party.create({ data: values, select: partySelect });

      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'party',
        entityId: created.id,
        action: 'OTHER',
        event: 'party.create',
        changes: [
          { field: 'name', old: null, new: values.name },
          { field: 'address', old: null, new: values.address },
          { field: 'email', old: null, new: values.email },
          { field: 'country', old: null, new: values.country },
        ],
      });

      return created;
    });

    return mapPartyRow(row);
  } catch (err) {
    if (isAppError(err)) throw err;

    const known = await partyConflictOf(err, values);
    if (isAppError(known)) throw known;

    throw new InternalError({ reason: 'PARTIES_CREATE_UNEXPECTED' }, err);
  }
}

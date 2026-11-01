import { Prisma } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import type { AuditChange } from '@db/adminAudit.helper.js';
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  isAppError,
} from '@utils/errors.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { isEuCountry, normalizeParty, type PartyValues } from '@helpers/party.js';

import {
  mapPartyRow,
  partyConflictOf,
  partySelect,
  productsNaming,
} from './helpers/parties.helper.js';

import type { PartyDto, UpdatePartyDto } from 'types/dto/parties.dto.js';

const FIELDS = ['name', 'address', 'email', 'country'] as const;

// changes the values of a party that were named; a party is one row for every product that names
// it, so the change shows in all of them. A country outside the EU is refused while it would leave a
// product with a manufacturer there and no person in the EU, or a person that is not in the EU
export async function updateParty({
  actorId,
  actorRole,
  partyId,
  body,
}: UpdatePartyDto): Promise<PartyDto> {
  assertAdminActor(actorId, actorRole);

  const values = normalizeParty(body, { path: '', required: false });
  if (!Object.keys(values).length) throw new BadRequestError('NO_FIELDS_TO_UPDATE');

  // what the row holds after the change, for the failure that says which party holds it already
  let target: PartyValues | null = null;

  try {
    const row = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // the row is held to the end: a product that names the party waits for this change, and the
      // check of its country below sees every product that named it before
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM cartlify.parties WHERE id = ${partyId} FOR UPDATE`,
      );

      const before = await tx.party.findUnique({ where: { id: partyId }, select: partySelect });
      if (!before) throw new NotFoundError('PARTY_NOT_FOUND');

      const changed = FIELDS.filter(
        (key) => values[key] !== undefined && values[key] !== before[key],
      );
      // the values named are the ones it has: nothing to write, nothing to log
      if (!changed.length) return before;

      target = {
        name: values.name ?? before.name,
        address: values.address ?? before.address,
        email: values.email ?? before.email,
        country: values.country ?? before.country,
      };

      if (changed.includes('country') && !isEuCountry(target.country)) {
        const naming = await productsNaming(tx, partyId, {
          manufacturer: true,
          euResponsible: true,
          onlyBare: true,
        });
        if (naming.total > 0) throw new ConflictError('PARTY_COUNTRY_CHANGE_REFUSED', naming);
      }

      const updated = await tx.party.update({
        where: { id: partyId },
        data: Object.fromEntries(changed.map((key) => [key, values[key]])),
        select: partySelect,
      });

      const changes: AuditChange[] = changed.map((key) => ({
        field: key,
        old: before[key],
        new: values[key],
      }));
      await writeAdminAuditLog(tx, {
        actorId,
        actorRole,
        entityType: 'party',
        entityId: partyId,
        action: 'OTHER',
        event: 'party.update',
        changes,
      });

      return updated;
    });

    return mapPartyRow(row);
  } catch (err) {
    if (isAppError(err)) throw err;

    if (target) {
      const known = await partyConflictOf(err, target, partyId);
      if (isAppError(known)) throw known;
    }

    throw new InternalError({ reason: 'PARTIES_UPDATE_UNEXPECTED' }, err);
  }
}

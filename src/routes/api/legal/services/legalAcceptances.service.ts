import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { checkChosenVersions } from './helpers/legalConsent.helper.js';
import {
  acceptanceStatusOf,
  knownDocumentIds,
  recordConsents,
} from './helpers/legalDocuments.helper.js';

import type { LegalAcceptanceStatusDto } from 'types/dto/legal.dto.js';
import type { UserId } from 'types/ids.js';

// the consent of a customer to the versions in force: given at the registration, or here for an
// account made without the form (a provider) and for a new version. Each consent keeps the address
// and the browser of the request (db/05)

// what the customer sees of the status: not the ids the checks take
const publicStatus = (status: LegalAcceptanceStatusDto): LegalAcceptanceStatusDto => ({
  current: status.current,
  accepted: status.accepted,
  required: status.required,
});

export async function getAcceptanceStatus(userId: UserId): Promise<LegalAcceptanceStatusDto> {
  const status = await prisma.$transaction(async (db) => {
    await setUserContext(db, { userId, role: 'USER' });
    return acceptanceStatusOf(db, Number(userId));
  });
  return publicStatus(status);
}

// each version named has to be in force; one the customer accepted already is not written again
export async function acceptLegalDocuments(args: {
  userId: UserId;
  documentIds: number[];
}): Promise<LegalAcceptanceStatusDto> {
  const userId = Number(args.userId);

  const status = await prisma.$transaction(async (db) => {
    await setUserContext(db, { userId, role: 'USER' });
    const before = await acceptanceStatusOf(db, userId);
    checkChosenVersions(
      before.versions,
      args.documentIds,
      await knownDocumentIds(db, args.documentIds),
      {
        every: false,
      },
    );

    const accepted = new Set(before.accepted.map((row) => row.documentId));
    await recordConsents(
      db,
      userId,
      args.documentIds.filter((id) => !accepted.has(id)),
    );
    return acceptanceStatusOf(db, userId);
  });

  return publicStatus(status);
}

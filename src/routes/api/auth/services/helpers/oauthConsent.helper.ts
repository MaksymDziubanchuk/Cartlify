import type { Prisma, Role } from '@prisma/client';

import { setUserContext } from '@db/dbContext.service.js';
import { checkChosenVersions } from '@routes/api/legal/services/helpers/legalConsent.helper.js';
import {
  currentDocuments,
  knownDocumentIds,
  recordConsents,
  takeConsentAtLogin,
  versionsOf,
} from '@routes/api/legal/services/helpers/legalDocuments.helper.js';

// the consent of a login by Google, GitHub or LinkedIn: the page of the shop sends the versions of
// the terms and of the contract the person accepted with the start of the login
// (acceptedDocumentIds), the signed state of the login carries them to the callback

// the ids of the query of the start, each once; the route schema lets through only a list of ids
export const documentIdsOfQuery = (raw?: string): number[] =>
  raw ? [...new Set(raw.split(',').map(Number))] : [];

// the ids the state of the login carries
export const acceptedOfState = (state: { accepted?: unknown }): number[] =>
  Array.isArray(state.accepted)
    ? state.accepted.filter((id): id is number => Number.isInteger(id) && id > 0)
    : [];

// an account the login makes takes the consent to every version in force, the way a registration
// does; a login to an account the shop has takes the versions that came in force since its last
// consent, the way a login with a password does (an admin or root buys nothing). A refusal
// (LEGAL_ACCEPTANCE_REQUIRED, LEGAL_VERSION_OUTDATED, LEGAL_DOCUMENT_NOT_FOUND) rolls the login
// back, no account is made, and the callback hands its code to the page
export async function takeConsentAtOAuthLogin(
  tx: Prisma.TransactionClient,
  login: { userId: number; role: Role; created: boolean; accepted: readonly number[] },
): Promise<void> {
  if (!login.created) {
    if (login.role !== 'USER') return;
    // the consents are read and written by their owner (db/03)
    await setUserContext(tx, { userId: login.userId, role: 'USER' });
    await takeConsentAtLogin(tx, login.userId, login.accepted);
    return;
  }

  const current = versionsOf(await currentDocuments(tx));
  checkChosenVersions(current, login.accepted, await knownDocumentIds(tx, login.accepted), {
    every: true,
  });
  if (!login.accepted.length) return;

  // a consent is written by its owner (db/03)
  await setUserContext(tx, { userId: login.userId, role: 'USER' });
  await recordConsents(tx, login.userId, login.accepted);
}

import { BadRequestError, ConflictError, NotFoundError } from '@utils/errors.js';

import type { LegalDocumentKind } from 'types/dto/legal.dto.js';

// what a consent of a customer means against the versions in force; the database keeps the
// versions and the consents (legalDocuments.helper.ts), this only decides

// the kinds in the order a page shows them and a list names them
export const LEGAL_DOCUMENT_KINDS: readonly LegalDocumentKind[] = ['terms', 'contract'];

export type CurrentVersion = {
  id: number;
  kind: LegalDocumentKind;
  version: number;
  title: string;
};

// the kinds whose version in force the customer did not accept (accepted: the version of each
// kind they accepted last); none while no version is in force
export function requiredKinds(
  current: readonly CurrentVersion[],
  accepted: ReadonlyMap<LegalDocumentKind, number>,
): LegalDocumentKind[] {
  return LEGAL_DOCUMENT_KINDS.filter((kind) => {
    const inForce = current.find((doc) => doc.kind === kind);
    return inForce !== undefined && accepted.get(kind) !== inForce.id;
  });
}

// the versions in force as a refusal names them: the page shows a checkbox for each and opens its
// text by its id (GET /api/legal/documents/:documentId)
export const detailsOf = (current: readonly CurrentVersion[]) =>
  current.map(({ id, kind, version, title }) => ({ id, kind, version, title }));

// the versions a customer sends: each one has to be there (known) and in force; a registration
// has to name every kind in force (every)
export function checkChosenVersions(
  current: readonly CurrentVersion[],
  chosen: readonly number[],
  known: ReadonlySet<number>,
  opts: { every: boolean },
): void {
  const missing = chosen.filter((id) => !known.has(id));
  if (missing.length) throw new NotFoundError('LEGAL_DOCUMENT_NOT_FOUND', { documentIds: missing });

  const inForce = new Set(current.map((doc) => doc.id));
  if (chosen.some((id) => !inForce.has(id))) {
    throw new ConflictError('LEGAL_VERSION_OUTDATED', { current: detailsOf(current) });
  }

  if (opts.every) {
    const kinds = requiredKinds(
      current,
      new Map(current.filter((doc) => chosen.includes(doc.id)).map((doc) => [doc.kind, doc.id])),
    );
    if (kinds.length) {
      throw new BadRequestError('LEGAL_ACCEPTANCE_REQUIRED', {
        kinds,
        current: detailsOf(current),
      });
    }
  }
}

// the versions in force changed while a consent was written: the database refused one
export const outdatedVersions = (current: readonly CurrentVersion[]) =>
  new ConflictError('LEGAL_VERSION_OUTDATED', { current: detailsOf(current) });

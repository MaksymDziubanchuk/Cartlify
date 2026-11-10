import { Prisma, type LegalDocumentKind as DbKind } from '@prisma/client';

import { getPgMessage, prisma } from '@db/client.js';
import { ConflictError } from '@utils/errors.js';

import { MAX_ID } from '@schemas/idPathParam.js';

import {
  CONSENT_KINDS,
  checkChosenVersions,
  detailsOf,
  outdatedVersions,
  requiredKinds,
  type CurrentVersion,
} from './legalConsent.helper.js';

import type { ConsentEvent, WrittenEvent } from '@config/journalEvents.js';
import type {
  ConsentKind,
  ContractTermsDto,
  LegalAcceptanceStatusDto,
  LegalDocumentDto,
  LegalDocumentKind,
  PrivacyRetentionDto,
} from 'types/dto/legal.dto.js';

// the versions of the terms, of the contract and of the privacy policy, and the consents to the
// terms and to the contract, read and written in the transaction of the caller, under its context:
// everybody reads the versions, a customer keeps a consent of their own (db/03). The version in
// force of a kind is its latest one; a customer accepts the versions in force of the terms and of
// the contract (the consent versions), the privacy policy only informs

type Db = Prisma.TransactionClient;

export const legalDocumentSelect = {
  id: true,
  kind: true,
  version: true,
  title: true,
  content: true,
  sha256: true,
  createdAt: true,
  withdrawalDays: true,
  returnAddress: true,
  returnShippingPaidBy: true,
  retentionLoginAddressesDays: true,
  retentionGuestDataDays: true,
  retentionDeletedChatsDays: true,
  retentionReturnAddressesDays: true,
  retentionReturnPersonalDays: true,
  retentionRecipientDays: true,
  retentionNewsletterConsentDays: true,
  retentionNewsletterRecipientsDays: true,
} as const;

type LegalDocumentRow = Prisma.LegalDocumentGetPayload<{ select: typeof legalDocumentSelect }>;

// the database keeps the fields of a kind together (db/06), so a contract has all three of its
// fields and a privacy policy all eight of its terms, or the row is not of that kind
const contractOf = (row: LegalDocumentRow): ContractTermsDto | null =>
  row.kind === 'contract' &&
  row.withdrawalDays !== null &&
  row.returnAddress !== null &&
  row.returnShippingPaidBy !== null
    ? {
        withdrawalDays: row.withdrawalDays,
        returnAddress: row.returnAddress,
        returnShippingPaidBy: row.returnShippingPaidBy,
      }
    : null;

const retentionOf = (row: LegalDocumentRow): PrivacyRetentionDto | null =>
  row.kind === 'privacy' &&
  row.retentionLoginAddressesDays !== null &&
  row.retentionGuestDataDays !== null &&
  row.retentionDeletedChatsDays !== null &&
  row.retentionReturnAddressesDays !== null &&
  row.retentionReturnPersonalDays !== null &&
  row.retentionRecipientDays !== null &&
  row.retentionNewsletterConsentDays !== null &&
  row.retentionNewsletterRecipientsDays !== null
    ? {
        loginAddressesDays: row.retentionLoginAddressesDays,
        guestDataDays: row.retentionGuestDataDays,
        deletedChatsDays: row.retentionDeletedChatsDays,
        returnAddressesDays: row.retentionReturnAddressesDays,
        returnPersonalDays: row.retentionReturnPersonalDays,
        recipientDays: row.retentionRecipientDays,
        newsletterConsentDays: row.retentionNewsletterConsentDays,
        newsletterRecipientsDays: row.retentionNewsletterRecipientsDays,
      }
    : null;

export const legalDocumentOf = (row: LegalDocumentRow): LegalDocumentDto => ({
  id: row.id,
  kind: row.kind as LegalDocumentKind,
  version: row.version,
  title: row.title,
  content: row.content,
  sha256: row.sha256,
  publishedAt: row.createdAt.toISOString(),
  contract: contractOf(row),
  retention: retentionOf(row),
});

// the kinds in the order a page shows them: the ones a customer accepts first
const KINDS_IN_ORDER: readonly LegalDocumentKind[] = [...CONSENT_KINDS, 'privacy'];

const byKind = (a: { kind: DbKind }, b: { kind: DbKind }) =>
  KINDS_IN_ORDER.indexOf(a.kind as LegalDocumentKind) -
  KINDS_IN_ORDER.indexOf(b.kind as LegalDocumentKind);

// the latest version of each kind that has one, terms first
export async function currentDocuments(db: Db): Promise<LegalDocumentRow[]> {
  const rows = await db.legalDocument.findMany({
    distinct: ['kind'],
    orderBy: [{ kind: 'asc' }, { version: 'desc' }],
    select: legalDocumentSelect,
  });
  return rows.sort(byKind);
}

// the versions in force of the kinds a customer accepts: the ones a registration, a login, an
// order and the page of consents work with
export async function currentConsentDocuments(db: Db): Promise<LegalDocumentRow[]> {
  return (await currentDocuments(db)).filter((row) => isConsentKind(row.kind));
}

const isConsentKind = (kind: DbKind): boolean => CONSENT_KINDS.includes(kind as ConsentKind);

export const versionsOf = (rows: LegalDocumentRow[]): CurrentVersion[] =>
  rows.map((row) => ({
    id: row.id,
    kind: row.kind as ConsentKind,
    version: row.version,
    title: row.title,
  }));

// the ids of these versions that are there; an id past the range of the column is none of them
export async function knownDocumentIds(db: Db, ids: readonly number[]): Promise<Set<number>> {
  const valid = ids.filter((id) => Number.isInteger(id) && id >= 1 && id <= MAX_ID);
  if (!valid.length) return new Set();
  const rows = await db.legalDocument.findMany({
    where: { id: { in: valid } },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

type AcceptedRow = { documentId: number; kind: DbKind; version: number; createdAt: Date };

// the version of each kind the customer accepted last, a consent of their own (not one of an order)
async function acceptedOf(db: Db, userId: number): Promise<AcceptedRow[]> {
  const rows = await db.legalAcceptance.findMany({
    where: { userId, orderId: null },
    orderBy: [{ document: { version: 'desc' } }, { id: 'desc' }],
    select: {
      documentId: true,
      createdAt: true,
      document: { select: { kind: true, version: true } },
    },
  });

  const latest = new Map<DbKind, AcceptedRow>();
  for (const row of rows) {
    if (!latest.has(row.document.kind)) {
      latest.set(row.document.kind, {
        documentId: row.documentId,
        kind: row.document.kind,
        version: row.document.version,
        createdAt: row.createdAt,
      });
    }
  }
  return [...latest.values()].sort(byKind);
}

export async function acceptanceStatusOf(
  db: Db,
  userId: number,
): Promise<LegalAcceptanceStatusDto & { versions: CurrentVersion[] }> {
  const current = await currentConsentDocuments(db);
  const accepted = await acceptedOf(db, userId);
  const versions = versionsOf(current);

  return {
    current: versions.map(({ id, kind, version, title }) => ({ id, kind, version, title })),
    accepted: accepted.map((row) => ({
      documentId: row.documentId,
      kind: row.kind as ConsentKind,
      version: row.version,
      acceptedAt: row.createdAt.toISOString(),
    })),
    required: requiredKinds(
      versions,
      new Map(accepted.map((row) => [row.kind as ConsentKind, row.documentId])),
    ),
    versions,
  };
}

// writes the consents of the customer (orderId: the versions an order is confirmed with). The
// database takes only a version in force: one published meanwhile makes it LEGAL_VERSION_OUTDATED
export async function recordConsents(
  db: Db,
  userId: number,
  documentIds: readonly number[],
  // where the person agreed (src/config/journalEvents.ts)
  event: WrittenEvent<ConsentEvent>,
  orderId: number | null = null,
): Promise<void> {
  if (!documentIds.length) return;

  try {
    await db.$executeRaw`
      insert into cartlify.legal_acceptances ("userId", "documentId", "orderId", "event")
      select ${userId}::int, d.id, ${orderId}::int, ${event}
      from unnest(${[...documentIds]}::int[]) as d(id)
    `;
  } catch (err) {
    if (String(getPgMessage(err) ?? '').includes('LEGAL_DOCUMENT_NOT_CURRENT')) {
      // the transaction stopped with the refusal: the versions in force are read outside it
      throw outdatedVersions(
        versionsOf(await prisma.$transaction((tx) => currentConsentDocuments(tx))),
      );
    }
    throw err;
  }
}

// holds the versions in force of the kinds a customer accepts until the transaction ends: a
// version root publishes meanwhile waits for it (the lock of its kind, db/05). So the versions an
// order is confirmed with, and the contract whose days it keeps (confirm_order), are the ones in
// force when it commits, and the list read below cannot go stale under the confirmation
async function holdVersionsInForce(db: Db): Promise<void> {
  for (const kind of CONSENT_KINDS) {
    await db.$executeRaw`select pg_advisory_xact_lock_shared(hashtext(${`cartlify.legal_documents:${kind}`}))`;
  }
}

// an order is confirmed only by a customer who accepted the versions in force; it keeps them
export async function assertAcceptedForOrder(db: Db, userId: number): Promise<number[]> {
  await holdVersionsInForce(db);
  const status = await acceptanceStatusOf(db, userId);
  if (status.required.length) {
    throw new ConflictError('LEGAL_ACCEPTANCE_REQUIRED', {
      kinds: status.required,
      current: detailsOf(status.versions),
    });
  }
  return status.versions.map((version) => version.id);
}

// a login of a customer: the versions in force they did not accept yet come with the login
// (chosen), the page asked for them with LEGAL_ACCEPTANCE_REQUIRED. Each one chosen has to be in
// force; one accepted before is not written again. Nothing is asked while nothing is missing
export async function takeConsentAtLogin(
  db: Db,
  userId: number,
  chosen: readonly number[],
  // a login with a password, or with a provider (consent.oauth_login)
  event: WrittenEvent<ConsentEvent> = 'consent.login',
): Promise<void> {
  const status = await acceptanceStatusOf(db, userId);
  if (!status.required.length) return;

  checkChosenVersions(status.versions, chosen, await knownDocumentIds(db, chosen), {
    every: false,
  });

  const missing = status.required.filter((kind) => {
    const inForce = status.versions.find((version) => version.kind === kind);
    return inForce !== undefined && !chosen.includes(inForce.id);
  });
  if (missing.length) {
    throw new ConflictError('LEGAL_ACCEPTANCE_REQUIRED', {
      kinds: missing,
      current: detailsOf(status.versions),
    });
  }

  const accepted = new Set(status.accepted.map((row) => row.documentId));
  await recordConsents(
    db,
    userId,
    chosen.filter((id) => !accepted.has(id)),
    event,
  );
}
